import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import type { ToolCallBlock } from "@pi-ui/protocol";
import { groupLabel, partialArgs, summarizeToolCall } from "./summaries";
import { diffFromEdits, diffStats, editsFromArgs, languageFromPath, parsePiDiff, stripAnsi } from "./text";
import { ToolCallRow, ToolGroup } from "./ToolViews";
import type { ToolCallPart, ToolGroupPart } from "../grouping";

Element.prototype.scrollTo ??= function () {};

const call = (name: string, args: Record<string, unknown> | undefined, argsText?: string): ToolCallBlock => ({
  type: "toolCall",
  id: `id-${name}`,
  name,
  args,
  argsText,
});
const summary = (name: string, args: Record<string, unknown> | undefined, active = false) => {
  const s = summarizeToolCall(call(name, args), active);
  return `${s.verb} ${s.subject}`.trim();
};

describe("summarizeToolCall", () => {
  it("summarizes built-in pi tools", () => {
    expect(summary("bash", { command: "ls -la" })).toBe("Ran ls -la");
    expect(summary("bash", { command: "npm test" }, true)).toBe("Running npm test");
    expect(summary("read", { path: "src/a.ts" })).toBe("Read src/a.ts");
    expect(summary("read", { path: "a.ts", offset: 10, limit: 5 })).toBe("Read a.ts:10-14");
    expect(summary("write", { path: "b.md", content: "x" })).toBe("Wrote b.md");
    expect(summary("edit", { path: "c.ts", edits: [] })).toBe("Edited c.ts");
    expect(summary("grep", { pattern: "TODO", path: "src" })).toBe("Searched TODO in src");
    expect(summary("find", { pattern: "*.ts" })).toBe("Searched *.ts");
    expect(summary("ls", {})).toBe("Listed .");
  });

  it("truncates long / multi-line commands", () => {
    const s = summarizeToolCall(call("bash", { command: `echo ${"x".repeat(300)}\nsecond` }), false);
    expect(s.subject.length).toBeLessThanOrEqual(120);
    expect(s.subject.endsWith("…")).toBe(true);
    expect(summarizeToolCall(call("bash", { command: "a\nb" }), false).subject).toBe("a ⏎ b");
  });

  it("falls back to tool name + arg preview for unknown tools", () => {
    expect(summary("web_search", { query: "preact signals", limit: 5, nested: { a: 1 } })).toBe("web_search preact signals 5");
  });

  it("uses partial args while the call is streaming", () => {
    const s = summarizeToolCall(call("bash", undefined, '{"command": "git sta'), true);
    expect(s.verb).toBe("Running");
    const s2 = summarizeToolCall(call("read", undefined, '{"path": "src/x.ts", "off'), true);
    expect(s2.subject).toBe("src/x.ts");
  });

  it("partialArgs parses complete JSON and complete string fields of partial JSON", () => {
    expect(partialArgs('{"a":1}')).toEqual({ a: 1 });
    expect(partialArgs('{"path":"a\\"b","x":"unterminated')).toEqual({ path: 'a"b' });
    expect(partialArgs(undefined)).toEqual({});
  });

  it("labels groups", () => {
    expect(groupLabel(4, false)).toBe("Ran 4 tool calls");
    expect(groupLabel(2, true)).toBe("Running 2 tool calls…");
  });
});

describe("text helpers", () => {
  it("strips ANSI escapes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain");
  });

  it("maps file extensions to languages", () => {
    expect(languageFromPath("a/b/c.tsx")).toBe("tsx");
    expect(languageFromPath("x.py")).toBe("python");
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("README")).toBe("");
  });

  it("parses pi's edit diff format", () => {
    const lines = parsePiDiff([" 1 keep", "-2 old", "+2 new", "   ...", " 9 tail"].join("\n"));
    expect(lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "gap", "ctx"]);
    expect(lines[1]).toMatchObject({ text: "old", oldNo: 2 });
    expect(lines[2]).toMatchObject({ text: "new", newNo: 2 });
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("normalizes edit args in all shapes pi accepts", () => {
    const e = { oldText: "a", newText: "b" };
    expect(editsFromArgs({ path: "x", edits: [e] })).toEqual([e]);
    expect(editsFromArgs({ path: "x", edits: JSON.stringify([e]) })).toEqual([e]);
    expect(editsFromArgs({ path: "x", edits: e })).toEqual([e]);
    expect(editsFromArgs({ path: "x", oldText: "a", newText: "b" })).toEqual([e]);
    expect(diffFromEdits([e, e]).map((l) => l.kind)).toEqual(["del", "add", "gap", "del", "add"]);
  });
});

const part = (id: string, status: ToolCallPart["status"] = "done", output = "hi"): ToolCallPart => ({
  type: "tool",
  key: id,
  call: { type: "toolCall", id, name: "bash", args: { command: `echo ${id}` } },
  result: status === "streaming" || status === "pending" ? undefined : { toolCallId: id, toolName: "bash", status: status === "cancelled" ? "done" : status, output },
  status,
});

describe("ToolGroup / ToolCallRow", () => {
  it("expands a group into its calls and collapses again", () => {
    const group: ToolGroupPart = {
      type: "toolGroup",
      key: "g",
      calls: [part("a"), part("b"), part("c", "error", "boom")],
      items: [part("a"), part("b"), part("c", "error", "boom")],
      active: false,
      errorCount: 1,
    };
    render(<ToolGroup part={group} />);
    const header = screen.getByRole("button", { name: /Ran 3 tool calls/ });
    expect(header.textContent).toContain("1 failed");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("echo a")).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("echo a")).toBeTruthy();
    expect(screen.getByText("echo c")).toBeTruthy();

    fireEvent.click(header);
    expect(screen.queryByText("echo a")).toBeNull();
  });

  it("shows a running label while any call is active", () => {
    const group: ToolGroupPart = { type: "toolGroup", key: "g", calls: [part("a"), part("b", "running")], items: [part("a"), part("b", "running")], active: true, errorCount: 0 };
    render(<ToolGroup part={group} />);
    expect(screen.getByRole("button", { name: /Running 2 tool calls…/ })).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy(); // spinner
  });

  it("expands a single bash call into a terminal block with command and output", () => {
    const { container } = render(<ToolCallRow part={part("x", "done", "\u001b[32mhello\u001b[0m\n")} />);
    const row = screen.getByRole("button", { name: /Ran echo x/ });
    fireEvent.click(row);
    const pre = container.querySelector("pre")!;
    expect(pre.textContent).toContain("$ echo x");
    expect(pre.textContent).toContain("hello");
    expect(pre.textContent).not.toContain("\u001b");
  });

  it("a streaming call shows a spinner and can't expand", () => {
    const p: ToolCallPart = { type: "tool", key: "s", call: { type: "toolCall", id: "s", name: "bash", args: undefined, argsText: "" }, result: undefined, status: "streaming" };
    render(<ToolCallRow part={p} />);
    const row = screen.getByRole("button", { name: /Running/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders an edit call as a diff with +/- stats", () => {
    const p: ToolCallPart = {
      type: "tool",
      key: "e",
      call: { type: "toolCall", id: "e", name: "edit", args: { path: "a.ts", edits: [{ oldText: "a", newText: "b\nc" }] } },
      result: { toolCallId: "e", toolName: "edit", status: "done", output: "ok", details: { diff: "-1 a\n+1 b\n+2 c" } },
      status: "done",
    };
    const { container } = render(<ToolCallRow part={p} />);
    const row = screen.getByRole("button", { name: /Edited a.ts/ });
    expect(row.textContent).toContain("+2");
    expect(row.textContent).toContain("−1");
    fireEvent.click(row);
    expect(container.textContent).toContain("b");
    expect(container.querySelectorAll(".bg-success\\/10")).toHaveLength(2);
  });
});
