// Conversation mode's cues (I-180): tiny soft tones generated in code (no bundled files). They play
// through the voice engine's AVAudioEngine, so voice processing cancels them from the mic like the
// spoken replies. Outside a session (no engine) a system sound stands in.

import AudioToolbox
import AVFoundation

enum Cue: String {
  case listening, sent, working, done, error
  case workingTick = "working-tick"

  /// (frequency Hz, duration s, gain) per note; notes play back to back with a short gap.
  private var notes: [(Double, Double, Double)] {
    switch self {
    case .listening: return [(660, 0.07, 0.16), (880, 0.09, 0.16)]  // rising: "your turn"
    case .sent: return [(990, 0.06, 0.12)]  // a soft pop
    case .working: return [(440, 0.08, 0.12), (554, 0.10, 0.12)]  // low, calm
    case .workingTick: return [(523, 0.07, 0.06)]  // very quiet "still working"
    case .done: return [(880, 0.07, 0.14), (660, 0.10, 0.14)]  // falling
    case .error: return [(330, 0.10, 0.16), (262, 0.14, 0.16)]
    }
  }

  /// Fallback when no engine is running (system sound ids).
  var systemSound: SystemSoundID {
    switch self {
    case .listening: return 1113
    case .sent: return 1001
    case .working, .workingTick: return 1104
    case .done: return 1114
    case .error: return 1073
    }
  }

  static let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!

  /// The cue as one mono float buffer: sine notes with a raised-cosine attack/release (no clicks).
  func buffer() -> AVAudioPCMBuffer? {
    let rate = Cue.format.sampleRate
    let gap = 0.03
    let total = notes.reduce(0) { $0 + $1.1 + gap }
    guard let buf = AVAudioPCMBuffer(pcmFormat: Cue.format, frameCapacity: AVAudioFrameCount(total * rate)),
      let out = buf.floatChannelData?[0]
    else { return nil }
    var i = 0
    for (freq, dur, gain) in notes {
      let n = Int(dur * rate)
      let ramp = max(1, Int(0.012 * rate))
      for k in 0..<n {
        var env = 1.0
        if k < ramp { env = 0.5 - 0.5 * cos(Double.pi * Double(k) / Double(ramp)) }
        if k > n - ramp { env = 0.5 - 0.5 * cos(Double.pi * Double(n - k) / Double(ramp)) }
        // A little second harmonic makes it rounder than a pure beep.
        let t = Double(k) / rate
        let s = sin(2 * .pi * freq * t) + 0.25 * sin(4 * .pi * freq * t)
        out[i] = Float(s * env * gain)
        i += 1
      }
      for _ in 0..<Int(gap * rate) {
        out[i] = 0
        i += 1
      }
    }
    buf.frameLength = AVAudioFrameCount(i)
    return buf
  }
}
