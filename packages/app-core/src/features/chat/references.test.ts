import { beforeEach, describe, expect, it } from "vitest";
import { QUOTE_MAX_LINES, addReference, composerReferences, quoteLines, referenceQuote, referencesOf, removeReference, withReferences, type MessageReference } from "./references";

const ref = (over: Partial<MessageReference> = {}): MessageReference => ({ id: "b1", label: "Q3", message: { role: "assistant", timestamp: 0 }, text: "hello", ...over });
const at = () => "Sun 5 Oct, 14:32";

beforeEach(() => {
  composerReferences.value = new Map();
});

describe("composer references (I-203)", () => {
  it("are kept per composer, once each", () => {
    addReference("c1", ref());
    addReference("c1", ref());
    addReference("c1", ref({ id: "b2" }));
    addReference("c2", ref());
    expect(referencesOf("chat:c1").map((r) => r.id)).toEqual(["b1", "b2"]);
    removeReference("chat:c1", "b1");
    expect(referencesOf("chat:c1").map((r) => r.id)).toEqual(["b2"]);
    expect(referencesOf("chat:c2")).toHaveLength(1);
  });

  it("quote the start of the message: blank runs collapsed, cut by lines and characters", () => {
    expect(quoteLines("a\n\n\n\nb")).toBe("> a\n>\n> b");
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const quoted = quoteLines(many).split("\n");
    expect(quoted).toHaveLength(QUOTE_MAX_LINES + 1);
    expect(quoted.at(-1)).toBe("> …");
    const long = quoteLines("x".repeat(2000));
    expect(long.length).toBeLessThan(620);
    expect(long.endsWith("…")).toBe(true);
  });

  it("say whose message it was, its label and time, then the typed text", () => {
    expect(referenceQuote(ref(), at)).toBe("Re: your earlier reply (“Q3”, Sun 5 Oct, 14:32):\n> hello");
    expect(referenceQuote(ref({ message: { role: "user", timestamp: 0 }, passage: true }), at)).toContain("Re: a passage of my earlier message");
    expect(withReferences("and?", [ref(), ref({ id: "b2", label: "Other", text: "x" })], at)).toBe(
      "Re: your earlier reply (“Q3”, Sun 5 Oct, 14:32):\n> hello\n\nRe: your earlier reply (“Other”, Sun 5 Oct, 14:32):\n> x\n\nand?",
    );
    expect(withReferences("   ", [ref()], at)).toBe("Re: your earlier reply (“Q3”, Sun 5 Oct, 14:32):\n> hello");
    expect(withReferences("plain", [], at)).toBe("plain");
  });
});
