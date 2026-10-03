import { describe, expect, it } from "vitest";
import { splitUserCode } from "./user-code";

describe("splitUserCode (I-194)", () => {
  it("leaves plain text alone", () => {
    expect(splitUserCode("just **text** # here *.ts")).toEqual([{ type: "text", text: "just **text** # here *.ts" }]);
  });

  it("finds inline code spans", () => {
    expect(splitUserCode("like my `glade` project, see `pnpm dev`")).toEqual([
      { type: "text", text: "like my " },
      { type: "code", code: "glade" },
      { type: "text", text: " project, see " },
      { type: "code", code: "pnpm dev" },
    ]);
  });

  it("keeps unclosed or empty backticks and spans across lines literal", () => {
    expect(splitUserCode("a ` b")).toEqual([{ type: "text", text: "a ` b" }]);
    expect(splitUserCode("a `` b")).toEqual([{ type: "text", text: "a `` b" }]);
    expect(splitUserCode("a `b\nc` d")).toEqual([{ type: "text", text: "a `b\nc` d" }]);
  });

  it("finds fenced blocks with their language and drops the line breaks around them", () => {
    expect(splitUserCode("run this:\n```sh\npnpm i\npnpm dev\n```\nthen `x`")).toEqual([
      { type: "text", text: "run this:" },
      { type: "fence", code: "pnpm i\npnpm dev", language: "sh" },
      { type: "text", text: "then " },
      { type: "code", code: "x" },
    ]);
  });

  it("doesn't treat backticks inside a fence as inline code", () => {
    expect(splitUserCode("```\nconst s = `x`;\n```")).toEqual([{ type: "fence", code: "const s = `x`;", language: "" }]);
  });

  it("handles an empty fence and longer fences around shorter ones", () => {
    expect(splitUserCode("```\n```")).toEqual([{ type: "fence", code: "", language: "" }]);
    expect(splitUserCode("````md\n```js\nx\n```\n````")).toEqual([{ type: "fence", code: "```js\nx\n```", language: "md" }]);
  });

  it("keeps an unclosed fence literal", () => {
    expect(splitUserCode("```js\nconst a = 1")).toEqual([{ type: "text", text: "```js\nconst a = 1" }]);
  });
});
