import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_LIMITS,
  applyAgentEvent,
  emptyTranscript,
  messageText,
  type AgentEvent,
  type AssistantMessage,
  type Transcript,
} from "@glade/protocol";
import { PiEventTranslator, piThinkingLevels, translateMessages, translateModel } from "../src/harness/pi/translate.js";

type Json = Record<string, unknown>;

const records: Json[] = readFileSync(new URL("./fixtures/pi-tool-run.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Json);

const events = records.filter((r) => r.type !== "response");
const response = (id: string) => records.find((r) => r.type === "response" && r.id === id)!.data as Json;

const BASH_ID = "toolu_01A1YGSN68NmSL2JfbjFA3n3";
const READ_ID = "toolu_016vkmqWcp9XkNzd5LhdcoaQ";

function assertToolRunTranscript(t: Transcript): void {
  expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
  expect(messageText(t.messages[0]!)).toContain("Run `ls` with bash");

  const [a1, a2, a3] = t.messages.slice(1) as AssistantMessage[];
  expect(a1!.content.map((b) => b.type)).toEqual(["thinking", "toolCall"]);
  expect(a1!.content[1]).toMatchObject({ type: "toolCall", id: BASH_ID, name: "bash", args: { command: "ls" } });
  expect(a1!.stopReason).toBe("toolUse");
  expect(a2!.content.map((b) => b.type)).toEqual(["thinking", "toolCall"]);
  expect(a2!.content[1]).toMatchObject({ type: "toolCall", id: READ_ID, name: "read", args: { path: "a.txt" } });
  expect(a3!.content.map((b) => b.type)).toEqual(["thinking", "text"]);
  expect(a3!.content[0]).toMatchObject({ type: "thinking", text: expect.stringContaining("Perfect!") });
  expect(messageText(a3!)).toContain("**");
  expect(a3!.stopReason).toBe("stop");
  for (const m of [a1, a2, a3]) expect(m!.streaming).toBeFalsy();

  expect(t.toolResults[BASH_ID]).toMatchObject({ toolName: "bash", status: "done", output: "a.txt\nevents.jsonl\nprobe.mjs\n" });
  expect(t.toolResults[READ_ID]).toMatchObject({ toolName: "read", status: "done", output: "hello\n" });
}

describe("PiEventTranslator (recorded pi run)", () => {
  const translator = new PiEventTranslator();
  const translated: AgentEvent[] = events.flatMap((e) => translator.translate(e));

  it("folds into the expected transcript", () => {
    const t = translated.reduce(applyAgentEvent, emptyTranscript());
    assertToolRunTranscript(t);
  });

  it("ignores setWidget/setStatus extension noise", () => {
    expect(translated.some((e) => e.type === "ui_request" || e.type === "notify")).toBe(false);
  });

  it("brackets the run with run_start/run_end and running state", () => {
    expect(translated[0]).toEqual({ type: "run_start" });
    expect(translated.filter((e) => e.type === "run_end")).toHaveLength(1);
    const last = translated.at(-1);
    expect(last).toEqual({ type: "state", state: { isRunning: false } });
  });

  it("streams deltas into blocks before the final message_end", () => {
    // Fold only up to (not including) the last message_end: the final text must already be there.
    const lastEnd = translated.map((e) => e.type).lastIndexOf("message_end");
    const partial = translated.slice(0, lastEnd).reduce(applyAgentEvent, emptyTranscript());
    const last = partial.messages.at(-1) as AssistantMessage;
    expect(last.streaming).toBe(true);
    expect(messageText(last)).toContain("**");
  });

  it("translates extension dialogs and notifications", () => {
    const tr = new PiEventTranslator();
    expect(tr.translate({ type: "extension_ui_request", id: "q", method: "confirm", title: "Run?", message: "rm -rf" })).toEqual([
      { type: "ui_request", request: { id: "q", kind: "confirm", title: "Run?", message: "rm -rf", timeoutMs: undefined } },
    ]);
    expect(tr.translate({ type: "extension_ui_request", id: "n", method: "notify", message: "hi", notifyType: "warning" })).toEqual([
      { type: "notify", level: "warning", message: "hi" },
    ]);
  });
});

describe("translateMessages (get_messages)", () => {
  it("builds the same transcript from history", () => {
    const data = response("m") as { messages: Json[] };
    const t = translateMessages(data.messages, (i) => `h${i}`);
    assertToolRunTranscript(t);
    expect(t.messages[0]!.id).toBe("h0");
  });
});

describe("piThinkingLevels", () => {
  it("returns only off for non-reasoning models", () => {
    expect(piThinkingLevels({ id: "x", provider: "p", reasoning: false })).toEqual(["off"]);
  });

  it("excludes xhigh/max for reasoning models without a mapping", () => {
    expect(piThinkingLevels({ id: "x", provider: "p", reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("includes mapped xhigh and drops levels mapped to null", () => {
    expect(
      piThinkingLevels({ id: "x", provider: "p", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", minimal: null } }),
    ).toEqual(["off", "low", "medium", "high", "xhigh"]);
  });

  it("matches pi's get_available_thinking_levels for the recorded model", () => {
    const state = response("st0") as { model: Parameters<typeof piThinkingLevels>[0] };
    const levels = (response("t") as { levels: string[] }).levels;
    expect(piThinkingLevels(state.model)).toEqual(levels);
  });

  it("translates the recorded model list", () => {
    const models = (response("mod") as { models: Parameters<typeof translateModel>[0][] }).models.map(translateModel);
    expect(models.length).toBeGreaterThan(0);
    expect(models.find((m) => m.id === "claude-haiku-4-5")).toMatchObject({ provider: "anthropic", input: ["text", "image"] });
  });
});

describe("translateModel image limits", () => {
  const model = {
    id: "claude-x",
    provider: "anthropic",
    input: ["text", "image"],
    inputLimits: {
      maxRequestBytes: 33554432,
      images: { maxPerRequest: 600, resize: { maxWidth: 2000, maxHeight: 1800, maxBytes: 4718592, jpegQuality: 80 } },
    },
  };

  it("maps pi's inputLimits.images.resize to imageLimits", () => {
    expect(translateModel(model).imageLimits).toEqual({ maxWidth: 2000, maxHeight: 1800, maxBytes: 4718592, jpegQuality: 80 });
  });

  it("fills missing fields with defaults and omits limits when pi reports none", () => {
    const partial = { ...model, inputLimits: { images: { resize: { maxBytes: 1000000 } } } };
    expect(translateModel(partial).imageLimits).toEqual({ ...DEFAULT_IMAGE_LIMITS, maxBytes: 1000000 });
    expect(translateModel({ id: "t", provider: "p" }).imageLimits).toBeUndefined();
    expect("imageLimits" in translateModel({ id: "t", provider: "p" })).toBe(false);
  });
});

describe("provider errors", () => {
  const raw =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 10 MB maximum: 11324160 bytes > 10485760 bytes"},"request_id":"req_011"}';
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: raw, timestamp: 1 };

  it("makes errorMessage readable and keeps the raw text in errorDetails (history)", () => {
    const t = translateMessages([failed], (i) => `h${i}`);
    expect(t.messages[0]).toMatchObject({
      errorMessage: "Image exceeds 10 MB maximum (10.8 MB > 10 MB)",
      errorDetails: raw,
    });
  });

  it("does the same for live message_end events", () => {
    const tr = new PiEventTranslator();
    const out = tr.translate({ type: "message_end", message: failed });
    expect(out[0]).toMatchObject({ type: "message_end", message: { errorMessage: "Image exceeds 10 MB maximum (10.8 MB > 10 MB)", errorDetails: raw } });
  });

  it("cleans up retry notifications", () => {
    const tr = new PiEventTranslator();
    const out = tr.translate({ type: "auto_retry_end", success: false, finalError: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
    expect(out).toEqual([{ type: "notify", level: "error", message: "Request failed: Overloaded" }]);
  });

  it("leaves plain error text alone", () => {
    const t = translateMessages([{ ...failed, errorMessage: "Connection error." }], (i) => `h${i}`);
    expect(t.messages[0]).toMatchObject({ errorMessage: "Connection error." });
    expect((t.messages[0] as AssistantMessage).errorDetails).toBeUndefined();
  });
});
