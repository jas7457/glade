import { describe, expect, it } from "vitest";
import { sourceRange, toSpeakable } from "./speakable";

/** The markdown under a spoken word (first occurrence of `word` in the spoken text). */
function sourceOf(md: string, word: string): string | null {
  const s = toSpeakable(md);
  const at = s.text.indexOf(word);
  expect(at).toBeGreaterThanOrEqual(0);
  const r = sourceRange(s, at, at + word.length);
  return r ? md.slice(r[0], r[1]) : null;
}

describe("toSpeakable", () => {
  it("drops emphasis, inline code ticks and headings' marks", () => {
    expect(toSpeakable("# Done\n\nI **fixed** the `login` bug, _finally_.").text).toBe("Done.\nI fixed the login bug, finally.");
  });

  it("keeps snake_case and joins soft-wrapped lines", () => {
    expect(toSpeakable("Rename my_var\nto other_var.").text).toBe("Rename my_var to other_var.");
  });

  it("reads links by their text and bare URLs by their host", () => {
    expect(toSpeakable("See [the docs](https://example.com/a_b) or https://www.github.com/x/y.").text).toBe("See the docs or a link to github.com.");
    expect(toSpeakable("<https://tauri.app/start>").text).toBe("a link to tauri.app.");
  });

  it("announces code blocks, tables and images instead of reading them", () => {
    const md = "Here:\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![chart](x.png) done";
    const s = toSpeakable(md);
    expect(s.text).toBe("Here:\nThere's a code block on screen.\nThere's a table on screen.\nan image of chart done.");
    expect(s.text).not.toContain("const");
    expect(s.segments.filter((x) => x.note).map((x) => s.text.slice(x.start, x.end))).toEqual(["There's a code block on screen.", "There's a table on screen."]);
  });

  it("an unclosed code fence still counts as a code block", () => {
    expect(toSpeakable("Look:\n```\nrm -rf").text).toBe("Look:\nThere's a code block on screen.");
  });

  it("turns list items into sentences", () => {
    expect(toSpeakable("Steps:\n- install deps\n- run `pnpm test`\n1. commit!").text).toBe("Steps:\ninstall deps.\nrun pnpm test.\ncommit!");
  });

  it("drops rules, quotes' marks and HTML tags", () => {
    expect(toSpeakable("> quoted *text*\n\n---\n\nline<br>next <kbd>Cmd</kbd>").text).toBe("quoted text.\nline, next Cmd.");
  });

  it("maps spoken words back to the markdown", () => {
    expect(sourceOf("I **fixed** it", "fixed")).toBe("fixed");
    expect(sourceOf("Run `pnpm test` now", "pnpm")).toBe("pnpm");
    expect(sourceOf("- first item\n- second item", "second")).toBe("second");
    expect(sourceOf("See [the docs](https://x.dev) please", "docs")).toBe("docs");
    // Replaced text maps to what it stands for.
    expect(sourceOf("Go to https://example.com now", "link")).toBe("https://example.com");
    expect(sourceOf("A\n\n```\ncode\n```", "code block")).toBe("```\ncode\n```");
  });

  it("offsets stay inside the text", () => {
    const md = "## Title\n\nSome **bold** and `code`.\n\n- a\n- b  \n\nEnd";
    const s = toSpeakable(md);
    for (const seg of s.segments) {
      expect(seg.end).toBeLessThanOrEqual(s.text.length);
      if (seg.verbatim && seg.src) expect(md.slice(seg.src[0], seg.src[1])).toBe(s.text.slice(seg.start, seg.end));
    }
  });
});
