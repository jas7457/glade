import { describe, expect, it } from "vitest";
import type { AssistantMessage, ChatMessage, ContentBlock, Transcript } from "@glade/protocol";
import { newPieces, planTurn, splitSentences, type ReplyPiece } from "./reply-stream";
import { sourceRange } from "./speakable";

const user = (id: string, text = "hi"): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp: 1 });
function assistant(id: string, content: ContentBlock[], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { id, role: "assistant", content, timestamp: 1, ...extra };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const tool = (id: string, kind: "shell" | "read" | "edit" = "shell"): ContentBlock => ({ type: "toolCall", id, name: kind, kind, args: {} });
const transcript = (...messages: ChatMessage[]): Transcript => ({ messages, toolResults: {} });
const texts = (pieces: ReplyPiece[]) => pieces.map((p) => p.speech.text);

/**
 * Streams `markdown` into one assistant message `step` characters at a time and collects what
 * would be read, snapshot by snapshot (like the conversation does).
 */
function streamRead(markdown: string, step = 1): { read: string[]; snapshots: string[][] } {
  const keys: string[] = [];
  const read: string[] = [];
  const snapshots: string[][] = [];
  const take = (t: Transcript, ended: boolean) => {
    const fresh = newPieces(keys, planTurn(t, ended).pieces);
    keys.push(...fresh.map((p) => p.key));
    read.push(...texts(fresh));
    snapshots.push(texts(fresh));
  };
  for (let n = step; n < markdown.length; n += step) take(transcript(user("u"), assistant("a", [text(markdown.slice(0, n))], { streaming: true })), false);
  take(transcript(user("u"), assistant("a", [text(markdown)], { stopReason: "stop" })), true);
  return { read, snapshots };
}

/** What would be read if the whole reply were there at once. */
const readAtOnce = (markdown: string) => texts(planTurn(transcript(user("u"), assistant("a", [text(markdown)], { stopReason: "stop" })), true).pieces);

describe("splitSentences", () => {
  const split = (t: string) => splitSentences(t).map(([a, z]) => t.slice(a, z));

  it("splits at sentence ends and line breaks", () => {
    expect(split("It works. Run it again! Why? Because.\nNext line")).toEqual(["It works.", "Run it again!", "Why?", "Because.", "Next line"]);
  });

  it("keeps abbreviations, initials, numbers and lower-case continuations together", () => {
    expect(split("Use a tool, e.g. Vite or i.e. Rollup. Then stop.")).toEqual(["Use a tool, e.g. Vite or i.e. Rollup.", "Then stop."]);
    expect(split("Version 3.5 is out. It costs $4.20 now.")).toEqual(["Version 3.5 is out.", "It costs $4.20 now."]);
    expect(split("Ask Dr. Who and J. Smith about the U.S. Office.")).toEqual(["Ask Dr. Who and J. Smith about the U.S. Office."]);
    expect(split("It's approx. five minutes. Done.")).toEqual(["It's approx. five minutes.", "Done."]);
    expect(split('He said "stop." Then left.')).toEqual(['He said "stop."', "Then left."]);
    expect(split("Wait... Okay.")).toEqual(["Wait...", "Okay."]);
  });
});

describe("planTurn while streaming", () => {
  it("reads only finished sentences", () => {
    const at = (md: string) => texts(planTurn(transcript(user("u"), assistant("a", [text(md)], { streaming: true })), false).pieces);
    expect(at("The build passes. All forty")).toEqual(["The build passes."]);
    expect(at("The build passes")).toEqual([]);
    expect(at("The build passes.")).toEqual([]); // could still be "passes.5"… or more of the sentence
    expect(at("First paragraph\n\n")).toEqual(["First paragraph."]);
    expect(at("# Title\n")).toEqual(["Title."]);
    expect(at("Intro\nmore")).toEqual([]);
    const plan = planTurn(transcript(user("u"), assistant("a", [text("Done. Now the te")], { streaming: true })), false);
    expect(plan.tail?.speech.text).toBe("Now the te");
    expect(plan.tail?.sep).toBe(" ");
  });

  it("streaming reads the same sentences as reading it at once, never half of one", () => {
    const md = [
      "I looked at it, e.g. the `login` flow. Version 3.5 fixes it!",
      "",
      "## Steps",
      "- install deps",
      "- run `pnpm test`",
      "1. commit it",
      "",
      "Here is the code:",
      "```ts",
      "const a = 1; // Not read. At all.",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "See [the docs](https://example.com). That's all.",
    ].join("\n");
    for (const step of [1, 3, 7]) {
      const { read } = streamRead(md, step);
      expect(read).toEqual(readAtOnce(md));
    }
    expect(readAtOnce(md)).toEqual([
      "I looked at it, e.g. the login flow.",
      "Version 3.5 fixes it!",
      "Steps.",
      "install deps.",
      "run pnpm test.",
      "commit it.",
      "Here is the code:",
      "There's a code block on screen.",
      "There's a table on screen.",
      "See the docs.",
      "That's all.",
    ]);
  });

  it("announces a code block once, as soon as it opens, and never reads it", () => {
    const { snapshots, read } = streamRead("Look:\n```sh\nrm -rf build. Then more.\nls\n```\nDone now.", 1);
    expect(read.filter((t) => t.includes("code block"))).toHaveLength(1);
    expect(read.join(" ")).not.toContain("rm");
    // The announcement comes while the block is still being written.
    const announcedAt = snapshots.findIndex((s) => s.some((t) => t.includes("code block")));
    expect(announcedAt).toBeLessThan("Look:\n```sh\nrm".length);
  });

  it("the sentence before a split number or abbreviation waits", () => {
    const { read } = streamRead("It costs 3.5 dollars, e.g. Today. Ok.", 1);
    expect(read).toEqual(["It costs 3.5 dollars, e.g. Today.", "Ok."]);
  });

  it("keeps order across messages: text → tools (announced once per run) → text", () => {
    const t = transcript(
      user("u0"),
      assistant("old", [text("Old reply.")]),
      user("u"),
      assistant("a1", [text("Let me check."), tool("t1"), tool("t2", "read")], { stopReason: "toolUse" }),
      assistant("a2", [tool("t3")], { stopReason: "toolUse" }),
      assistant("a3", [text("All **good**. Next"), tool("t4", "edit")], { streaming: true }),
    );
    const plan = planTurn(t, false);
    expect(plan.turn).toBe("u");
    expect(texts(plan.pieces)).toEqual(["Let me check.", "Running a command.", "All good.", "Next.", "Editing a file."]);
    expect(plan.pieces.map((p) => p.sep)).toEqual(["\n", "\n", "\n", " ", "\n"]);
    expect(plan.pieces[1]!.speech.segments[0]!.note).toBe(true);
    // Words map back into their own message's markdown.
    const good = plan.pieces[2]!.speech;
    expect(sourceRange(good, 4, 8)).toEqual([6, 10]);
  });

  it("the tool run's announcement is final while the text after it streams", () => {
    const t = transcript(user("u"), assistant("a1", [tool("t1")], { stopReason: "toolUse" }), assistant("a2", [text("Tests pa")], { streaming: true }));
    const plan = planTurn(t, false);
    expect(texts(plan.pieces)).toEqual(["Running a command."]);
    expect(plan.tail?.speech.text).toBe("Tests pa");
  });

  it("says when the turn failed or was stopped, once it ended", () => {
    expect(texts(planTurn(transcript(user("u"), assistant("a", [], { stopReason: "error", errorMessage: "Rate limited" })), true).pieces)).toEqual(["Something went wrong: Rate limited"]);
    expect(texts(planTurn(transcript(user("u"), assistant("a", [text("Hm")], { stopReason: "aborted" })), true).pieces)).toEqual(["Hm.", "Stopped."]);
    expect(planTurn(transcript(user("u")), true)).toEqual({ turn: "u", pieces: [], tail: null });
  });
});

describe("newPieces", () => {
  const p = (key: string): ReplyPiece => ({ key, sep: " ", speech: { text: key, segments: [] } });
  it("takes what comes after the last known piece", () => {
    expect(newPieces([], [p("a"), p("b")]).map((x) => x.key)).toEqual(["a", "b"]);
    expect(newPieces(["a", "b"], [p("a"), p("b"), p("c")]).map((x) => x.key)).toEqual(["c"]);
    // An earlier piece re-keyed (re-rendered) isn't read again.
    expect(newPieces(["a", "b"], [p("a2"), p("b"), p("c")]).map((x) => x.key)).toEqual(["c"]);
    expect(newPieces(["a", "b"], [p("a"), p("b")])).toEqual([]);
  });
});
