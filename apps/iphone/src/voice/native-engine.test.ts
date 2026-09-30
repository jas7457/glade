import { describe, expect, it } from "vitest";
import type { ListenEvent, SpeakEvent } from "~/voice/engine";
import { createNativeVoiceEngine, type NativeBridge } from "~/voice/native-engine";

/** A fake Tauri bridge: records invokes and lets the test push events into the channels. */
function fakeBridge(responses: Record<string, unknown> = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const channels: ((m: unknown) => void)[] = [];
  const failing = new Set<string>();
  const bridge: NativeBridge = {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (failing.has(cmd)) throw new Error(`${cmd} failed`);
      return responses[cmd] as T;
    },
    channel: <T>(onMessage: (m: T) => void) => {
      channels.push(onMessage as (m: unknown) => void);
      return { channelIndex: channels.length - 1 };
    },
  };
  return { bridge, calls, channels, failing };
}

describe("native voice engine", () => {
  it("maps the plugin's commands and results", async () => {
    const perms = { microphone: "granted", speechRecognition: "undetermined" };
    const voices = [{ id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", language: "en-US", quality: "premium" }];
    const { bridge, calls } = fakeBridge({
      "plugin:voice|is_available": { value: true },
      "plugin:voice|get_permissions": perms,
      "plugin:voice|request_permissions": { ...perms, speechRecognition: "granted" },
      "plugin:voice|list_voices": { voices },
      "plugin:voice|request_personal_voice": { value: "denied" },
    });
    const engine = createNativeVoiceEngine(bridge);
    expect(await engine.isAvailable()).toBe(true);
    expect(await engine.permissions()).toEqual(perms);
    expect((await engine.requestPermissions()).speechRecognition).toBe("granted");
    expect(await engine.listVoices()).toEqual(voices);
    expect(await engine.requestPersonalVoice()).toBe("denied");
    await engine.startSession();
    await engine.playCue("working-tick");
    await engine.endSession();
    expect(calls.map((c) => c.cmd)).toEqual([
      "plugin:voice|is_available",
      "plugin:voice|get_permissions",
      "plugin:voice|request_permissions",
      "plugin:voice|list_voices",
      "plugin:voice|request_personal_voice",
      "plugin:voice|start_session",
      "plugin:voice|play_cue",
      "plugin:voice|end_session",
    ]);
    expect(calls[6]!.args).toEqual({ cue: "working-tick" });
  });

  it("is unavailable when the plugin is missing", async () => {
    const { bridge, failing } = fakeBridge();
    failing.add("plugin:voice|is_available");
    expect(await createNativeVoiceEngine(bridge).isAvailable()).toBe(false);
  });

  it("passes listen options with defaults and streams events until stopListening", async () => {
    const { bridge, calls, channels } = fakeBridge();
    const engine = createNativeVoiceEngine(bridge);
    const events: ListenEvent[] = [];
    await engine.startListening({ contextualStrings: ["yes", "always"] }, (e) => events.push(e));
    expect(calls[0]).toEqual({
      cmd: "plugin:voice|start_listening",
      args: { locale: undefined, endSilenceMs: 1200, contextualStrings: ["yes", "always"], onEvent: { channelIndex: 0 } },
    });
    channels[0]!({ type: "speech-start" });
    channels[0]!({ type: "partial", text: "hello" });
    channels[0]!({ type: "final", text: "hello there" });
    channels[0]!({ type: "error", message: "The audio route changed.", recoverable: true });
    channels[0]!({ type: "partial", text: "next" });
    await engine.stopListening();
    channels[0]!({ type: "final", text: "late" });
    expect(events.map((e) => e.type)).toEqual(["speech-start", "partial", "final", "error", "partial"]);
  });

  it("drops events of an older listening run and after a non-recoverable error", async () => {
    const { bridge, channels } = fakeBridge();
    const engine = createNativeVoiceEngine(bridge);
    const first: ListenEvent[] = [];
    const second: ListenEvent[] = [];
    await engine.startListening({ endSilenceMs: 800 }, (e) => first.push(e));
    await engine.startListening({}, (e) => second.push(e));
    channels[0]!({ type: "partial", text: "old" });
    channels[1]!({ type: "error", message: "Listening was interrupted.", recoverable: false });
    channels[1]!({ type: "partial", text: "after" });
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: "error", message: "Listening was interrupted.", recoverable: false }]);
  });

  it("rejects startListening when the plugin rejects", async () => {
    const { bridge, failing } = fakeBridge();
    failing.add("plugin:voice|start_listening");
    await expect(createNativeVoiceEngine(bridge).startListening({}, () => {})).rejects.toThrow("failed");
  });

  it("speaks with voice and rate and reports words, then one ending", async () => {
    const { bridge, calls, channels } = fakeBridge();
    const engine = createNativeVoiceEngine(bridge);
    const events: SpeakEvent[] = [];
    const text = "Héllo 👋 world";
    await engine.speak(text, { voiceId: "v1" }, (e) => events.push(e));
    expect(calls[0]).toEqual({ cmd: "plugin:voice|speak", args: { text, voiceId: "v1", rate: 1, onEvent: { channelIndex: 0 } } });
    // UTF-16 offsets from the native side index the JS string directly.
    channels[0]!({ type: "word", start: 0, end: 5 });
    channels[0]!({ type: "word", start: 9, end: 14 });
    channels[0]!({ type: "done" });
    channels[0]!({ type: "word", start: 0, end: 5 });
    expect(events).toEqual([{ type: "word", start: 0, end: 5 }, { type: "word", start: 9, end: 14 }, { type: "done" }]);
    expect(text.slice(9, 14)).toBe("world");
  });

  it("a replaced reply gets its cancelled but no more words", async () => {
    const { bridge, channels } = fakeBridge();
    const engine = createNativeVoiceEngine(bridge);
    const a: SpeakEvent[] = [];
    const b: SpeakEvent[] = [];
    await engine.speak("first", { rate: 1.5 }, (e) => a.push(e));
    await engine.speak("second", {}, (e) => b.push(e));
    channels[0]!({ type: "word", start: 0, end: 5 });
    channels[0]!({ type: "cancelled" });
    channels[1]!({ type: "word", start: 0, end: 6 });
    await engine.stopSpeaking();
    channels[1]!({ type: "cancelled" });
    channels[1]!({ type: "cancelled" });
    expect(a).toEqual([{ type: "cancelled" }]);
    expect(b).toEqual([{ type: "word", start: 0, end: 6 }, { type: "cancelled" }]);
  });
});
