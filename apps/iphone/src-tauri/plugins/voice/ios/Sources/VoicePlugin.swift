// Conversation mode's native voice engine (PLAN.md I-180), the Swift half of `plugin:voice`.
// The contract is apps/iphone/src/voice/engine.ts (`VoiceEngine`); native-engine.ts is the TS
// adapter. Commands arrive on Tauri's IPC queue and hop to the main queue: all state below is
// main-queue only (the mic tap reads the current request through `RequestBox`).
//
// Audio: one AVAudioEngine per session with voice processing on the input node (Apple's echo
// canceller). Replies are synthesized with AVSpeechSynthesizer.write (buffers + word markers) and
// played through that engine's player node, so the canceller has them as its reference signal and
// the user can talk over a reply (barge-in). Cues play through the same engine.
//
// Queued speech (I-183): `speak` with `queue: true` appends a piece (`SpeechItem`) after what's
// playing. Pieces are synthesized one after the other (the next starts at the previous one's
// didFinish, so while it still plays) and their buffers are scheduled on the same player node right
// after the previous ones, so they follow without a gap. Each piece has its own channel, its own
// marker timeline and its own `done`.
//
// Recognition: SFSpeechRecognizer on-device only; one recognition task per utterance. A pause of
// `endSilenceMs` after the last change ends the utterance (`final`) and a fresh task starts, which
// also keeps each task well under the ~1 minute limit.

import AVFoundation
import Speech
import Tauri
import UIKit
import WebKit

struct ListenArgs: Decodable {
  let locale: String?
  let endSilenceMs: Double?
  let contextualStrings: [String]?
  let onEvent: Channel
}

struct SpeakArgs: Decodable {
  let text: String
  let voiceId: String?
  let rate: Double?
  /// Speak after what's playing instead of replacing it (engine.ts `SpeakOptions.queue`).
  let queue: Bool?
  let onEvent: Channel
}

struct CueArgs: Decodable {
  let cue: String
}

struct VoiceList: Encodable {
  let voices: [VoiceInfo]
}

/// Encodes like engine.ts `VoiceInfo` (`personal` left out unless true).
struct VoiceInfo: Encodable {
  let id: String
  let name: String
  let language: String
  let quality: String
  let personal: Bool?
}

/// The current recognition request, shared with the audio thread (mic tap).
final class RequestBox {
  private let lock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  func set(_ r: SFSpeechAudioBufferRecognitionRequest?) {
    lock.lock()
    request = r
    lock.unlock()
  }
  func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    let r = request
    lock.unlock()
    r?.append(buffer)
  }
}

/// A word marker of a piece being spoken: where in the piece's audio it starts (a frame of the
/// piece's own timeline, in the synthesizer's sample rate) and its text range.
private struct WordMark {
  let frame: Int64
  let start: Int
  let end: Int
}

/// Maps AVSpeechSynthesisMarker.byteSampleOffset to a frame of the whole reply (I-181).
///
/// Measured (trace behind `-GladeVoiceTrace YES`, simulator + macOS, 2026-09-30): the synthesizer
/// renders a longer text in several chunks (e.g. after a list or every few paragraphs). Each chunk
/// ends with an *empty* buffer, and the next chunk's markers start again at byteSampleOffset 0,
/// counted from that chunk's first sample. Within a chunk the offset is bytes of the synth's own
/// buffer format (4 × frames for mono Float32) and the markers arrive in text order, a little
/// ahead of their audio. Sorting every marker by its raw offset (the old code) interleaved the
/// chunks: the highlight hopped between paragraphs and whole runs of words fired at once.
///
/// So a marker's frame is `chunkBase + byte / bytesPerFrame`, where `chunkBase` is the number of
/// frames scheduled before the chunk began (the count at its empty end-buffer). If an offset ever
/// goes clearly backwards without an empty buffer (a chunk we didn't see end), the chunk is
/// assumed to start at the frames scheduled so far. Frames never go backwards, so the marks stay
/// in arrival (= text) order.
private struct MarkTimeline {
  private var chunkBase: Int64 = 0
  private var nextChunkBase: Int64?
  private var lastByte: Int64 = 0
  private var lastFrame: Int64 = 0

  /// The previous chunk ended (empty buffer) after `framesScheduled` frames.
  mutating func chunkEnded(framesScheduled: Int64) {
    nextChunkBase = framesScheduled
  }

  mutating func frame(byte: Int64, bytesPerFrame: Int64, framesScheduled: Int64, sampleRate: Double) -> Int64 {
    let bpf = max(bytesPerFrame, 1)
    if let base = nextChunkBase {
      chunkBase = base
      nextChunkBase = nil
      lastByte = 0
    } else if byte < lastByte - Int64(sampleRate / 2) * bpf {
      // More than half a second backwards: a new chunk.
      chunkBase = framesScheduled
      lastByte = 0
    }
    lastByte = max(lastByte, byte)
    lastFrame = max(lastFrame, chunkBase + byte / bpf)
    return lastFrame
  }
}

/// One `speak` call (I-183): its text and channel, where its audio sits on the player's timeline and
/// its word markers. Frames are the piece's own (0 = its first sample, synthesizer's sample rate);
/// `base` + frames × `ratio` is the player's timeline.
private final class SpeechItem {
  let channel: Channel
  let utterance: AVSpeechUtterance
  var timeline = MarkTimeline()
  /// Frames of this piece scheduled so far (its own timeline).
  var frames: Int64 = 0
  /// Where its first sample sits on the player's timeline (set with its first buffer).
  var base: Int64?
  /// Player frames per synthesizer frame (1 unless the piece had to be resampled).
  var ratio: Double = 1
  var sampleRate: Double = 22_050
  var bytesPerFrame: Int64 = 4
  var marks: [WordMark] = []
  var nextMark = 0
  var lastWord: (Int, Int)?
  var pendingBuffers = 0
  var synthStarted = false
  var synthEnded = false
  /// The last synthesis buffer was an empty one (a chunk ended; see MarkTimeline).
  var afterChunkEnd = false
  var cancelled = false

  init(channel: Channel, utterance: AVSpeechUtterance) {
    self.channel = channel
    self.utterance = utterance
  }

  /// The piece's own frame for a player frame.
  func localFrame(_ playerFrame: Int64) -> Int64? {
    guard let base else { return nil }
    return Int64(Double(playerFrame - base) / ratio)
  }
}

/// Debug trace of speech timing (I-181), off by default: launch with `-GladeVoiceTrace YES`.
private let voiceTrace = UserDefaults.standard.bool(forKey: "GladeVoiceTrace")
private let traceT0 = Date()
private func trace(_ s: @autoclosure () -> String) {
  guard voiceTrace else { return }
  NSLog("VOICETRACE %.3f %@", Date().timeIntervalSince(traceT0), s())
}

class VoicePlugin: Plugin, AVSpeechSynthesizerDelegate {
  // Session
  private var sessionActive = false
  private var engine: AVAudioEngine?
  // Fresh nodes per engine (a node can't move to another engine, e.g. after a media reset).
  private var speechPlayer = AVAudioPlayerNode()
  private var cuePlayer = AVAudioPlayerNode()
  private var speechFormat: AVAudioFormat?
  private var observers: [NSObjectProtocol] = []

  // Listening
  private let requestBox = RequestBox()
  private var listening = false
  private var listenChannel: Channel?
  private var recognizer: SFSpeechRecognizer?
  private var contextualStrings: [String] = []
  private var endSilence: TimeInterval = 1.2
  private var task: SFSpeechRecognitionTask?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var taskGen = 0
  private var utterance = ""
  private var speechStarted = false
  private var silenceTimer: Timer?
  private var taskAgeTimer: Timer?
  private var recentFailures: [Date] = []

  // Speaking
  private let synth = AVSpeechSynthesizer()
  /// The pieces being spoken and queued, in order (the first is the one being heard).
  private var items: [SpeechItem] = []
  /// Engine path: synthesis into buffers played by `speechPlayer`, words from markers.
  private var viaEngine = false
  /// Frames scheduled on `speechPlayer` since it last started (its timeline).
  private var playerScheduled: Int64 = 0
  /// Buffers scheduled and not played yet, over all pieces.
  private var totalPending = 0
  /// The piece `synth.write` is rendering.
  private var synthesizing: SpeechItem?
  private var wordLink: CADisplayLink?

  override init() {
    super.init()
    synth.delegate = self
  }

  // MARK: - Commands (names: build.rs COMMANDS in lowerCamelCase)

  @objc func isAvailable(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let rec = SFSpeechRecognizer()
      let ok = (rec?.supportsOnDeviceRecognition ?? false) && !AVSpeechSynthesisVoice.speechVoices().isEmpty
      invoke.resolve(["value": ok])
    }
  }

  @objc func getPermissions(_ invoke: Invoke) {
    invoke.resolve(Self.currentPermissions())
  }

  @objc override func requestPermissions(_ invoke: Invoke) {
    requestMicrophone {
      self.requestSpeech {
        invoke.resolve(Self.currentPermissions())
      }
    }
  }

  /// Not in the `VoiceEngine` contract yet: asks to use the user's Personal Voice (iOS shows its
  /// prompt once); afterwards `list_voices` includes it.
  @objc func requestPersonalVoice(_ invoke: Invoke) {
    AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
      invoke.resolve(["value": Self.personalVoiceString(status)])
    }
  }

  @objc func listVoices(_ invoke: Invoke) {
    let voices = AVSpeechSynthesisVoice.speechVoices()
      .filter { !$0.voiceTraits.contains(.isNoveltyVoice) }
      .map { v -> VoiceInfo in
        let quality: String
        switch v.quality {
        case .premium: quality = "premium"
        case .enhanced: quality = "enhanced"
        default: quality = "default"
        }
        let personal = v.voiceTraits.contains(.isPersonalVoice)
        return VoiceInfo(id: v.identifier, name: v.name, language: v.language, quality: quality, personal: personal ? true : nil)
      }
    invoke.resolve(VoiceList(voices: voices))
  }

  @objc func startSession(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do {
        try self.ensureSession()
        invoke.resolve()
      } catch {
        invoke.reject("Couldn't start the audio session: \(error.localizedDescription)")
      }
    }
  }

  @objc func endSession(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.teardownSession()
      invoke.resolve()
    }
  }

  @objc func startListening(_ invoke: Invoke) {
    let args: ListenArgs
    do { args = try invoke.parseArgs(ListenArgs.self) } catch {
      invoke.reject("Bad start_listening arguments: \(error)")
      return
    }
    DispatchQueue.main.async {
      self.startListening(args)
      invoke.resolve()
    }
  }

  @objc func stopListening(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.stopRecognition()
      invoke.resolve()
    }
  }

  @objc func speak(_ invoke: Invoke) {
    let args: SpeakArgs
    do { args = try invoke.parseArgs(SpeakArgs.self) } catch {
      invoke.reject("Bad speak arguments: \(error)")
      return
    }
    DispatchQueue.main.async {
      self.speak(args)
      invoke.resolve()
    }
  }

  @objc func stopSpeaking(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.cancelSpeech(event: ["type": "cancelled"])
      invoke.resolve()
    }
  }

  @objc func playCue(_ invoke: Invoke) {
    let args: CueArgs
    do { args = try invoke.parseArgs(CueArgs.self) } catch {
      invoke.reject("Bad play_cue arguments: \(error)")
      return
    }
    guard let cue = Cue(rawValue: args.cue) else {
      invoke.reject("Unknown cue \(args.cue)")
      return
    }
    DispatchQueue.main.async {
      self.play(cue)
      invoke.resolve()
    }
  }

  // MARK: - Permissions

  static func currentPermissions() -> JsonObject {
    let mic: String
    switch AVAudioApplication.shared.recordPermission {
    case .granted: mic = "granted"
    case .denied: mic = "denied"
    default: mic = "undetermined"
    }
    let speech: String
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: speech = "granted"
    case .denied: speech = "denied"
    case .restricted: speech = "restricted"
    default: speech = "undetermined"
    }
    return ["microphone": mic, "speechRecognition": speech]
  }

  static func personalVoiceString(_ s: AVSpeechSynthesizer.PersonalVoiceAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .unsupported: return "restricted"
    default: return "undetermined"
    }
  }

  private func requestMicrophone(_ done: @escaping () -> Void) {
    guard AVAudioApplication.shared.recordPermission == .undetermined else { return done() }
    AVAudioApplication.requestRecordPermission { _ in done() }
  }

  private func requestSpeech(_ done: @escaping () -> Void) {
    guard SFSpeechRecognizer.authorizationStatus() == .notDetermined else { return done() }
    SFSpeechRecognizer.requestAuthorization { _ in done() }
  }

  // MARK: - Audio session + engine

  private func ensureSession() throws {
    if !sessionActive {
      let s = AVAudioSession.sharedInstance()
      // .voiceChat: the system's voice-call tuning (echo cancellation, speaker by default here).
      try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
      try s.setActive(true)
      sessionActive = true
      addObservers()
      UIApplication.shared.isIdleTimerDisabled = true
    }
    if engine == nil { try buildEngine() }
    if let e = engine, !e.isRunning { try e.start() }
  }

  private func buildEngine() throws {
    let e = AVAudioEngine()
    let input = e.inputNode
    do {
      // Echo cancellation: the mic ignores what this engine plays (replies, cues).
      try input.setVoiceProcessingEnabled(true)
      input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
    } catch {
      Logger.error("voice: voice processing unavailable: \(error)")
    }
    speechPlayer = AVAudioPlayerNode()
    cuePlayer = AVAudioPlayerNode()
    e.attach(speechPlayer)
    e.attach(cuePlayer)
    e.connect(cuePlayer, to: e.mainMixerNode, format: Cue.format)
    let fmt = speechFormat ?? AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1)!
    e.connect(speechPlayer, to: e.mainMixerNode, format: fmt)
    speechFormat = fmt
    installTap(on: e)
    NotificationCenter.default.addObserver(self, selector: #selector(engineConfigurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: e)
    e.prepare()
    engine = e
    try e.start()
  }

  private func installTap(on e: AVAudioEngine) {
    let input = e.inputNode
    input.removeTap(onBus: 0)
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      Logger.error("voice: no audio input")
      return
    }
    let box = requestBox
    // Voice processing can report several channels; recognition wants mono: keep channel 0.
    let mono = format.channelCount == 1 ? nil : AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      guard let mono, let src = buffer.floatChannelData else {
        box.append(buffer)
        return
      }
      guard let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength), let dst = out.floatChannelData else { return }
      out.frameLength = buffer.frameLength
      dst[0].update(from: src[0], count: Int(buffer.frameLength))
      box.append(out)
    }
  }

  private func teardownSession() {
    stopRecognition()
    cancelSpeech(event: ["type": "cancelled"])
    if let e = engine {
      NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: e)
      e.inputNode.removeTap(onBus: 0)
      e.stop()
    }
    engine = nil
    if sessionActive {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      sessionActive = false
    }
    removeObservers()
    UIApplication.shared.isIdleTimerDisabled = false
  }

  private func addObservers() {
    let nc = NotificationCenter.default
    observers = [
      nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
        self?.interrupted(n)
      },
      nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
        self?.routeChanged(n)
      },
      nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
        self?.mediaServicesReset()
      },
    ]
  }

  private func removeObservers() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
  }

  /// A call, Siri or another app took the audio: stop everything; the UI decides what next.
  private func interrupted(_ n: Notification) {
    guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    if type == .began {
      cancelSpeech(event: ["type": "error", "message": "Audio was interrupted."])
      failListening("Listening was interrupted by another app or a call.")
    } else if sessionActive {
      // Ended: take the audio back so the next startListening/speak works.
      try? AVAudioSession.sharedInstance().setActive(true)
      if let e = engine, !e.isRunning { try? e.start() }
    }
  }

  /// Headphones/AirPods came or went. The engine reconfigures (engineConfigurationChanged); a
  /// reply playing on headphones that were removed stops, like every other audio app.
  private func routeChanged(_ n: Notification) {
    guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
    else { return }
    if reason == .oldDeviceUnavailable, !items.isEmpty {
      cancelSpeech(event: ["type": "error", "message": "The audio device was disconnected."])
    }
  }

  @objc private func engineConfigurationChanged(_ n: Notification) {
    DispatchQueue.main.async {
      guard let e = self.engine, n.object as? AVAudioEngine === e else { return }
      Logger.info("voice: audio configuration changed")
      if !self.items.isEmpty, self.viaEngine {
        self.cancelSpeech(event: ["type": "error", "message": "The audio route changed."])
      }
      self.installTap(on: e)
      do {
        e.prepare()
        try e.start()
      } catch {
        self.failListening("Couldn't restart audio after the route changed: \(error.localizedDescription)")
        return
      }
      if self.listening {
        self.sendListen(["type": "error", "message": "The audio route changed.", "recoverable": true])
        self.restartTask()
      }
    }
  }

  private func mediaServicesReset() {
    let wasActive = sessionActive
    cancelSpeech(event: ["type": "error", "message": "Audio services were reset."])
    failListening("Audio services were reset.")
    if let e = engine { NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: e) }
    engine = nil
    sessionActive = false
    removeObservers()
    if wasActive { try? ensureSession() }
  }

  // MARK: - Listening

  private func startListening(_ args: ListenArgs) {
    stopRecognition()
    listenChannel = args.onEvent
    endSilence = max(0.3, (args.endSilenceMs ?? 1200) / 1000)
    contextualStrings = args.contextualStrings ?? []
    recentFailures = []

    guard AVAudioApplication.shared.recordPermission == .granted,
      SFSpeechRecognizer.authorizationStatus() == .authorized
    else {
      return failListening("Glade needs microphone and speech recognition access. Allow them in Settings → Glade.")
    }
    let locale = args.locale.map { Locale(identifier: $0) } ?? Locale.current
    guard let rec = SFSpeechRecognizer(locale: locale) else {
      return failListening("Speech recognition doesn't support \(locale.identifier).")
    }
    guard rec.supportsOnDeviceRecognition else {
      return failListening("On-device speech recognition isn't available for \(locale.identifier) on this iPhone.")
    }
    rec.defaultTaskHint = .dictation
    recognizer = rec
    do { try ensureSession() } catch {
      return failListening("Couldn't start the microphone: \(error.localizedDescription)")
    }
    listening = true
    startTask()
  }

  private func startTask() {
    guard listening, let rec = recognizer else { return }
    taskGen += 1
    let gen = taskGen
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.requiresOnDeviceRecognition = true
    req.shouldReportPartialResults = true
    req.addsPunctuation = true
    req.taskHint = .dictation
    if !contextualStrings.isEmpty { req.contextualStrings = contextualStrings }
    request = req
    utterance = ""
    speechStarted = false
    task = rec.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async { self?.onRecognition(gen, result, error) }
    }
    requestBox.set(req)
    // Tasks stop around a minute; renew a quiet one before that (a talking one ends by silence).
    taskAgeTimer?.invalidate()
    taskAgeTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: true) { [weak self] _ in
      guard let self, self.taskGen == gen, self.utterance.isEmpty else { return }
      self.restartTask()
    }
  }

  private func endTask() {
    taskGen += 1
    requestBox.set(nil)
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    silenceTimer?.invalidate()
    silenceTimer = nil
    taskAgeTimer?.invalidate()
    taskAgeTimer = nil
  }

  private func restartTask() {
    endTask()
    startTask()
  }

  private func onRecognition(_ gen: Int, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    guard gen == taskGen, listening else { return }
    if let result {
      let text = result.bestTranscription.formattedString
      if !text.isEmpty {
        if !speechStarted {
          speechStarted = true
          sendListen(["type": "speech-start"])
        }
        if text != utterance {
          utterance = text
          sendListen(["type": "partial", "text": text])
          silenceTimer?.invalidate()
          silenceTimer = Timer.scheduledTimer(withTimeInterval: endSilence, repeats: false) { [weak self] _ in
            guard let self, self.taskGen == gen else { return }
            self.finishUtterance()
          }
        }
      }
      if result.isFinal { return finishUtterance() }
    }
    if let error { recognitionFailed(error as NSError) }
  }

  /// The pause (or the recognizer) ended the utterance: report it and listen for the next one.
  private func finishUtterance() {
    let text = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      sendListen(["type": "final", "text": text])
      recentFailures = []
    }
    restartTask()
  }

  private func recognitionFailed(_ error: NSError) {
    // Speech framework codes that just mean "nothing to hear / task ended": renew quietly.
    // 1110 no speech detected, 1107/1101 transient, 216/301/209/203 cancelled or retry.
    let quiet: Set<Int> = [1110, 1107, 1101, 216, 301, 209, 203]
    if !utterance.isEmpty { return finishUtterance() }
    if quiet.contains(error.code) { return restartTask() }
    Logger.error("voice: recognition error \(error.domain) \(error.code): \(error.localizedDescription)")
    let now = Date()
    recentFailures = recentFailures.filter { now.timeIntervalSince($0) < 30 } + [now]
    if recentFailures.count >= 3 {
      return failListening("Speech recognition keeps failing: \(error.localizedDescription)")
    }
    sendListen(["type": "error", "message": error.localizedDescription, "recoverable": true])
    endTask()
    let gen = taskGen
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self, self.listening, self.taskGen == gen else { return }
      self.startTask()
    }
  }

  /// Stops listening and tells the UI it has to start again (recoverable: false).
  private func failListening(_ message: String) {
    let channel = listenChannel
    stopRecognition()
    channel?.send(["type": "error", "message": message, "recoverable": false])
  }

  private func stopRecognition() {
    listening = false
    endTask()
    listenChannel = nil
  }

  private func sendListen(_ event: JsonObject) {
    listenChannel?.send(event)
  }

  // MARK: - Speaking

  private func speak(_ args: SpeakArgs) {
    if !(args.queue ?? false) { cancelSpeech(event: ["type": "cancelled"]) }

    let u = AVSpeechUtterance(string: args.text)
    if let id = args.voiceId, let v = AVSpeechSynthesisVoice(identifier: id) {
      u.voice = v
    } else {
      u.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }
    // Contract rate 0.5…2 (1 = normal) → AVSpeechUtterance rate (default 0.5, range 0…1).
    let factor = Float(min(max(args.rate ?? 1, 0.5), 2))
    u.rate = min(max(AVSpeechUtteranceDefaultSpeechRate * factor, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)

    let item = SpeechItem(channel: args.onEvent, utterance: u)
    if items.isEmpty {
      // Nothing playing: pick the path for this piece and whatever gets queued after it.
      viaEngine = (try? ensureSession()) != nil && engine?.isRunning == true
      playerScheduled = 0
      totalPending = 0
    }
    items.append(item)
    trace("SPEAK queue=\(args.queue ?? false) items=\(items.count) len=\((args.text as NSString).length)")

    if viaEngine {
      if wordLink == nil {
        let link = CADisplayLink(target: self, selector: #selector(tickWords))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30)
        link.add(to: .main, forMode: .common)
        wordLink = link
      }
      synthesizeNext()
    } else {
      // No engine (audio session refused): speak directly (the synthesizer queues utterances
      // itself); no echo cancellation then.
      item.synthStarted = true
      synth.speak(u)
    }
  }

  /// Starts rendering the next queued piece once the synthesizer is free (engine path).
  private func synthesizeNext() {
    guard viaEngine, synthesizing == nil, let item = items.first(where: { !$0.synthStarted }) else { return }
    item.synthStarted = true
    synthesizing = item
    synth.write(
      item.utterance,
      toBufferCallback: { [weak self] buffer in
        DispatchQueue.main.async { self?.onSynthBuffer(item, buffer) }
      },
      toMarkerCallback: { [weak self] markers in
        DispatchQueue.main.async { self?.onMarkers(item, markers) }
      })
  }

  private func onSynthBuffer(_ item: SpeechItem, _ buffer: AVAudioBuffer) {
    guard !item.cancelled, let e = engine else { return }
    guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
      // An empty buffer ends a synthesis *chunk*, not the piece (more chunks can follow; see
      // MarkTimeline). The piece is complete at didFinish.
      trace("BUF empty (chunk end) itemFrames=\(item.frames)")
      item.timeline.chunkEnded(framesScheduled: item.frames)
      item.afterChunkEnd = true
      return checkChunkGap(item)
    }
    item.afterChunkEnd = false
    let bpf = Int64(pcm.format.streamDescription.pointee.mBytesPerFrame)
    if bpf > 0 { item.bytesPerFrame = bpf }
    item.sampleRate = pcm.format.sampleRate
    guard var playable = Self.floatBuffer(pcm) else { return }
    if speechFormat != playable.format {
      if totalPending == 0, item.frames == 0 {
        // Nothing left to play: reconnect the player for this format (its timeline restarts).
        speechPlayer.stop()
        e.disconnectNodeOutput(speechPlayer)
        e.connect(speechPlayer, to: e.mainMixerNode, format: playable.format)
        speechFormat = playable.format
        playerScheduled = 0
      } else if let fmt = speechFormat, let converted = Self.resample(playable, to: fmt) {
        // Another voice's rate while the previous piece plays (rare): resample it.
        item.ratio = fmt.sampleRate / playable.format.sampleRate
        playable = converted
      } else {
        return
      }
    }
    if item.base == nil {
      // It starts where the audio before it ends, or now if the player ran dry meanwhile.
      var base = playerScheduled
      if totalPending == 0, let now = playerFrame(), now > base { base = now }
      item.base = base
      playerScheduled = base
    }
    trace("BUF frames=\(pcm.frameLength) fmt=\(pcm.format.commonFormat.rawValue)/\(pcm.format.sampleRate)/ch\(pcm.format.channelCount)/bpf\(bpf) playable=\(playable.frameLength)@\(playable.format.sampleRate) itemFrames=\(item.frames) base=\(item.base ?? -1) sched=\(playerScheduled) player=\(playerFrame() ?? -1)")
    item.frames += Int64(pcm.frameLength)
    item.pendingBuffers += 1
    totalPending += 1
    playerScheduled += Int64(playable.frameLength)
    speechPlayer.scheduleBuffer(playable, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, !item.cancelled else { return }
        item.pendingBuffers -= 1
        self.totalPending -= 1
        self.finishPlayedItems()
        self.checkChunkGap(item)
      }
    }
    if !speechPlayer.isPlaying { speechPlayer.play() }
  }

  private func onMarkers(_ item: SpeechItem, _ markers: [AVSpeechSynthesisMarker]) {
    guard !item.cancelled else { return }
    for m in markers {
      trace("MARK type=\(m.mark.rawValue) byte=\(m.byteSampleOffset) range=\(m.textRange.location)+\(m.textRange.length) itemFrames=\(item.frames) player=\(playerFrame() ?? -1)")
    }
    let text = item.utterance.speechString as NSString
    for m in markers where m.mark == .word {
      let frame = item.timeline.frame(
        byte: Int64(m.byteSampleOffset), bytesPerFrame: item.bytesPerFrame, framesScheduled: item.frames,
        sampleRate: item.sampleRate)
      // Some voices mark punctuation (".", "-") as words: keep the highlight on the last word.
      guard Self.isWord(m.textRange, in: text) else { continue }
      // textRange is an NSRange in UTF-16 code units; JS strings are UTF-16 too, so the offsets
      // go through unchanged as JS string indices. Kept in arrival order (= text order).
      item.marks.append(WordMark(frame: frame, start: m.textRange.location, end: m.textRange.location + m.textRange.length))
    }
  }

  @objc private func tickWords() {
    guard viaEngine, let now = playerFrame() else { return }
    for item in items {
      guard let local = item.localFrame(now) else { break }
      emitWords(item, upTo: local)
    }
  }

  /// Reports the word being heard at `frame` (the piece's own timeline): only the latest one that
  /// has started, so a late tick (or late markers) moves the highlight once instead of flashing
  /// through every word it missed; never a word before the last reported one.
  private func emitWords(_ item: SpeechItem, upTo frame: Int64) {
    var latest: WordMark?
    while item.nextMark < item.marks.count, item.marks[item.nextMark].frame <= frame {
      latest = item.marks[item.nextMark]
      item.nextMark += 1
    }
    guard let m = latest else { return }
    if let last = item.lastWord {
      // Some words get two markers (an emoji; "$42.50" then "$42.50,"): same or earlier start
      // isn't a new word.
      if m.start < last.0 || (m.start, m.end) == last { return }
    }
    item.lastWord = (m.start, m.end)
    trace("WORD \(m.start)+\(m.end - m.start) markFrame=\(m.frame) itemFrame=\(frame)")
    item.channel.send(["type": "word", "start": m.start, "end": m.end])
  }

  private func playerFrame() -> Int64? {
    guard speechPlayer.isPlaying, let n = speechPlayer.lastRenderTime, let t = speechPlayer.playerTime(forNodeTime: n) else { return nil }
    return t.sampleTime
  }

  /// Safety net: didFinish normally ends a piece. If everything has played after a chunk's end
  /// and nothing more arrives for 2 s, treat the piece as complete anyway.
  private func checkChunkGap(_ item: SpeechItem) {
    guard !item.cancelled, item.afterChunkEnd, item.pendingBuffers == 0, !item.synthEnded else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self, !item.cancelled, item.afterChunkEnd, item.pendingBuffers == 0, !item.synthEnded else { return }
      trace("no didFinish after the last chunk: done")
      self.synthesisEnded(item)
    }
  }

  /// A piece's synthesis is complete: it's done once played; the next one can be rendered.
  private func synthesisEnded(_ item: SpeechItem) {
    item.synthEnded = true
    if synthesizing === item { synthesizing = nil }
    finishPlayedItems()
    synthesizeNext()
  }

  /// Sends `done` for the pieces at the front that are synthesized and played, in order.
  private func finishPlayedItems() {
    while let first = items.first, first.synthEnded, first.pendingBuffers == 0 {
      emitWords(first, upTo: .max)
      items.removeFirst()
      trace("DONE left=\(items.count)")
      first.channel.send(["type": "done"] as JsonObject)
    }
    if items.isEmpty { stopPlayback() }
  }

  /// Stops every piece (the one playing and the queued ones) and reports `event` for each.
  private func cancelSpeech(event: JsonObject) {
    guard !items.isEmpty else { return }
    let all = items
    items = []
    for item in all { item.cancelled = true }
    synthesizing = nil
    stopPlayback()
    synth.stopSpeaking(at: .immediate)
    for item in all { item.channel.send(event) }
  }

  private func stopPlayback() {
    wordLink?.invalidate()
    wordLink = nil
    if viaEngine { speechPlayer.stop() }
    playerScheduled = 0
    totalPending = 0
  }

  /// Whether `range` of `text` has a letter or digit (not just punctuation or a list dash).
  private static func isWord(_ range: NSRange, in text: NSString) -> Bool {
    guard range.location != NSNotFound, range.location + range.length <= text.length else { return true }
    return text.substring(with: range).rangeOfCharacter(from: .alphanumerics) != nil
  }

  /// Synthesis buffers may be Int16; the player node and mixer want float.
  private static func floatBuffer(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if pcm.format.commonFormat == .pcmFormatFloat32, !pcm.format.isInterleaved { return pcm }
    guard let fmt = AVAudioFormat(standardFormatWithSampleRate: pcm.format.sampleRate, channels: pcm.format.channelCount),
      let conv = AVAudioConverter(from: pcm.format, to: fmt),
      let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: pcm.frameLength)
    else { return nil }
    do { try conv.convert(to: out, from: pcm) } catch { return nil }
    return out
  }

  /// `pcm` in another format (sample rate / channels), for a piece whose voice renders differently
  /// from the one playing.
  private static func resample(_ pcm: AVAudioPCMBuffer, to fmt: AVAudioFormat) -> AVAudioPCMBuffer? {
    guard let conv = AVAudioConverter(from: pcm.format, to: fmt) else { return nil }
    let capacity = AVAudioFrameCount(Double(pcm.frameLength) * fmt.sampleRate / pcm.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .endOfStream
        return nil
      }
      fed = true
      status.pointee = .haveData
      return pcm
    }
    return error == nil && out.frameLength > 0 ? out : nil
  }

  // Direct-speech fallback (no engine): the synthesizer's own delegate callbacks.

  private func item(for utterance: AVSpeechUtterance) -> SpeechItem? {
    items.first { $0.utterance === utterance }
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
    DispatchQueue.main.async {
      guard !self.viaEngine, let item = self.item(for: utterance), Self.isWord(range, in: utterance.speechString as NSString) else { return }
      trace("WILLSPEAK \(range.location)+\(range.length)")
      // UTF-16 offsets, same as JS string indices.
      item.channel.send(["type": "word", "start": range.location, "end": range.location + range.length])
    }
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    DispatchQueue.main.async {
      guard let item = self.item(for: utterance), !item.cancelled else { return }
      if self.viaEngine {
        // Engine path: synthesis is complete (every chunk delivered); done once the scheduled
        // audio has played. The next piece is rendered meanwhile.
        trace("DIDFINISH pending=\(item.pendingBuffers) frames=\(item.frames)")
        return self.synthesisEnded(item)
      }
      item.synthEnded = true
      self.finishPlayedItems()
    }
  }

  // MARK: - Cues

  private func play(_ cue: Cue) {
    guard let e = engine, e.isRunning, let buf = cue.buffer() else {
      AudioServicesPlaySystemSound(cue.systemSound)
      return
    }
    cuePlayer.scheduleBuffer(buf, at: nil, options: [.interrupts])
    if !cuePlayer.isPlaying { cuePlayer.play() }
  }
}

@_cdecl("init_plugin_voice")
func initPlugin() -> Plugin {
  return VoicePlugin()
}
