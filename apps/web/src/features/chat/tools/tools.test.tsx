import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import type { ToolCallBlock, ToolInput, ToolKind } from "@glade/protocol";
import { groupLabel, partialArgs, summarizeToolCall } from "./summaries";
import { diffFromEdits, diffStats, languageFromPath, stripAnsi } from "./text";
import { currentKind, dominantKind, groupKinds, ToolCallRow, ToolGroup } from "./ToolViews";
import { toolCallStatus, type ToolCallPart, type ToolGroupPart } from "../grouping";
import { SpawnLinksContext } from "../spawn-context";
import { NO_SPAWN_LINKS } from "../agent-spawns";

Element.prototype.scrollTo ??= function () {};

// Tool names are deliberately not real harness names: the UI must only look at kind + input.
const call = (kind: ToolKind, input: ToolInput | undefined, extra: Partial<ToolCallBlock> = {}): ToolCallBlock => ({
  type: "toolCall",
  id: `id-${kind}`,
  name: `x_${kind}`,
  kind,
  input,
  args: {},
  ...extra,
});
const summary = (kind: ToolKind, input: ToolInput, active = false) => {
  const s = summarizeToolCall(call(kind, input), active);
  return `${s.verb} ${s.subject}`.trim();
};

describe("summarizeToolCall", () => {
  it("summarizes each canonical kind from the normalized input", () => {
    expect(summary("shell", { command: "ls -la" })).toBe("Ran ls -la");
    expect(summary("shell", { command: "npm test" }, true)).toBe("Running npm test");
    expect(summary("read", { path: "src/a.ts" })).toBe("Read src/a.ts");
    expect(summary("read", { path: "a.ts", offset: 10, limit: 5 })).toBe("Read a.ts:10-14");
    expect(summary("write", { path: "b.md", content: "x" })).toBe("Wrote b.md");
    expect(summary("edit", { path: "c.ts", edits: [] })).toBe("Edited c.ts");
    expect(summary("search", { pattern: "TODO", path: "src" })).toBe("Searched TODO in src");
    expect(summary("search", { pattern: "useState", glob: "*.tsx" })).toBe("Searched useState (*.tsx)");
    expect(summary("search", { pattern: "*.ts" })).toBe("Searched *.ts");
    expect(summary("list", {})).toBe("Listed .");
    expect(summary("web", { url: "https://example.com" })).toBe("Fetched https://example.com");
    expect(summary("web", { query: "preact signals" }, true)).toBe("Searching the web for preact signals");
    expect(summary("task", { description: "Review the diff" })).toBe("Ran task Review the diff");
    // I-145: a sub-agent spawn reads by the agent's name, not its task.
    expect(summary("task", { agentName: "t3-research", description: "Research T3" }, true)).toBe("Starting agent t3-research");
    expect(summary("task", { agentName: "t3-research", description: "Research T3" })).toBe("Started agent t3-research");
    // I-089: web results lookups, agent-teams and MCP.
    expect(summary("web", { description: 'looking for "Source:"' })).toBe('Read web results looking for "Source:"');
    expect(summary("agent", { agentAction: "message", agentName: "reviewer", description: "Please check" })).toBe("Messaged reviewer: Please check");
    expect(summary("agent", { agentAction: "close", agentName: "reviewer" }, true)).toBe("Closing reviewer");
    expect(summary("agent", { agentAction: "list" })).toBe("Listed agents");
    expect(summary("mcp", { server: "chrome-devtools", tool: "take_snapshot" })).toBe("Called chrome-devtools › take_snapshot");
    expect(summary("mcp", { query: "screenshot" })).toBe("Searched MCP tools for screenshot");
    expect(summary("mcp", { description: "script" }, true)).toBe("Running MCP script");
  });

  it("summarizes the chat tools from their input and result (I-099)", () => {
    const chat = (input: ToolInput, output?: string, active = false) => {
      const s = summarizeToolCall(call("chat", input), active, output);
      return `${s.verb} ${s.subject}`.trim();
    };
    const find: ToolInput = { chatAction: "find", query: "toolbar button" };
    expect(chat(find, undefined, true)).toBe('Searching chats for "toolbar button"');
    expect(chat(find)).toBe('Searched chats for "toolbar button"');
    expect(chat(find, "3 chat(s) (keyword matches):\n\n1. …")).toBe('Found 3 chats for "toolbar button"');
    expect(chat(find, "1 chat(s) (picked by x):\n\n1. …")).toBe('Found 1 chat for "toolbar button"');
    expect(chat(find, 'No chats found for "toolbar button".')).toBe('Found no chats for "toolbar button"');
    const read: ToolInput = { chatAction: "read", chatId: "s-1" };
    expect(chat(read, undefined, true)).toBe("Reading chat s-1");
    expect(chat(read, '"Add a "new" button" — project glade, last active 2026-09-27\nid: s-1 (workspace w-1)')).toBe('Read chat "Add a "new" button"');
    expect(chat(read, "Unexpected output")).toBe("Read chat s-1");
    const open: ToolInput = { chatAction: "open", chatId: "s-1" };
    expect(chat(open, 'Opened "Toolbar" in Glade.')).toBe('Opened chat "Toolbar"');
    expect(chat(open, 'No Glade window is open; "Toolbar" will not be shown. Tell the user its title instead.')).toBe('No window to show chat "Toolbar"');
    expect(chat(open)).toBe("Opened chat s-1");
  });

  it("truncates long / multi-line commands", () => {
    const s = summarizeToolCall(call("shell", { command: `echo ${"x".repeat(300)}\nsecond` }), false);
    expect(s.subject.length).toBeLessThanOrEqual(120);
    expect(s.subject.endsWith("…")).toBe(true);
    expect(summarizeToolCall(call("shell", { command: "a\nb" }), false).subject).toBe("a ⏎ b");
  });

  it("falls back to the tool name + raw arg preview for `other` tools", () => {
    const s = summarizeToolCall(call("other", undefined, { name: "web_search", args: { query: "preact signals", limit: 5, nested: { a: 1 } } }), false);
    expect(`${s.verb} ${s.subject}`).toBe("web_search preact signals 5");
    // A kind this build doesn't know behaves like `other`.
    const unknown = summarizeToolCall(call("teleport" as ToolKind, { path: "x" }, { name: "beam", args: { to: "mars" } }), false);
    expect(`${unknown.verb} ${unknown.subject}`).toBe("beam mars");
  });

  it("uses the partial input while the call is streaming", () => {
    const s = summarizeToolCall(call("shell", undefined, { args: undefined, argsText: '{"command": "git sta' }), true);
    expect(s).toMatchObject({ verb: "Running", subject: "" });
    const s2 = summarizeToolCall(call("read", { path: "src/x.ts" }, { args: undefined, argsText: '{"path": "src/x.ts", "off' }), true);
    expect(s2.subject).toBe("src/x.ts");
    const s3 = summarizeToolCall(call("other", undefined, { name: "ask", args: undefined, argsText: '{"question": "why?", "x' }), true);
    expect(`${s3.verb} ${s3.subject}`).toBe("ask why?");
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

  it("builds a preview diff from normalized edits and counts it", () => {
    const e = { oldText: "a", newText: "b\nc" };
    const lines = diffFromEdits([e, e]);
    expect(lines.map((l) => l.type)).toEqual(["del", "add", "add", "gap", "del", "add", "add"]);
    expect(diffStats(lines)).toEqual({ added: 4, removed: 2 });
  });
});

const part = (id: string, status: ToolCallPart["status"] = "done", output = "hi"): ToolCallPart => ({
  type: "tool",
  key: id,
  call: { type: "toolCall", id, name: "x_shell", kind: "shell", input: { command: `echo ${id}` }, args: {} },
  result: status === "streaming" || status === "pending" ? undefined : { toolCallId: id, toolName: "x_shell", status: status === "cancelled" ? "done" : status === "rejected" ? "error" : status, output },
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
    const p: ToolCallPart = { type: "tool", key: "s", call: { type: "toolCall", id: "s", name: "x_shell", kind: "shell", args: undefined, argsText: "" }, result: undefined, status: "streaming" };
    render(<ToolCallRow part={p} />);
    const row = screen.getByRole("button", { name: /Running/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders an edit call as a diff with +/- stats", () => {
    const p: ToolCallPart = {
      type: "tool",
      key: "e",
      call: { type: "toolCall", id: "e", name: "x_edit", kind: "edit", input: { path: "a.ts", edits: [{ oldText: "a", newText: "b\nc" }] }, args: {} },
      result: {
        toolCallId: "e",
        toolName: "x_edit",
        status: "done",
        output: "ok",
        diff: [
          { type: "context", text: "keep", oldLine: 1 },
          { type: "del", text: "a", oldLine: 2 },
          { type: "add", text: "b", newLine: 2 },
          { type: "add", text: "c", newLine: 3 },
        ],
      },
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

  it("previews an edit from its normalized edits before the harness reports a diff", () => {
    const p: ToolCallPart = {
      type: "tool",
      key: "e2",
      call: { type: "toolCall", id: "e2", name: "x_edit", kind: "edit", input: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }, args: {} },
      result: undefined,
      status: "pending",
    };
    const { container } = render(<ToolCallRow part={p} />);
    const row = screen.getByRole("button", { name: /Editing a.ts/ });
    expect(row.textContent).toContain("+1");
    fireEvent.click(row);
    expect(container.querySelectorAll(".bg-danger\\/10")).toHaveLength(1);
  });

  it("shows an `other` tool's raw args and output", () => {
    const p: ToolCallPart = {
      type: "tool",
      key: "o",
      call: { type: "toolCall", id: "o", name: "spawn_helper", kind: "other", args: { goal: "tidy up" } },
      result: { toolCallId: "o", toolName: "spawn_helper", status: "done", output: "all tidy" },
      status: "done",
    };
    const { container } = render(<ToolCallRow part={p} />);
    const row = screen.getByRole("button", { name: /spawn_helper tidy up/ });
    fireEvent.click(row);
    expect(container.textContent).toContain('"goal": "tidy up"');
    expect(container.textContent).toContain("all tidy");
  });
});

describe("tool colours (I-077)", () => {
  const part = (kind: ToolKind, status: ToolCallPart["status"], id: string = kind): ToolCallPart => ({
    type: "tool",
    key: id,
    call: call(kind, {}, { id }),
    result: undefined,
    status,
  });

  it("tones a row by its kind, and red when it failed", () => {
    const { container, rerender } = render(<ToolCallRow part={part("read", "done")} />);
    expect(container.querySelector(".pi-tone-icon")?.getAttribute("data-tone")).toBe("read");
    rerender(<ToolCallRow part={part("read", "error")} />);
    expect(container.querySelector(".pi-tone-icon")?.getAttribute("data-tone")).toBe("danger");
  });

  it("shows a call the user rejected as Rejected, muted, not as a failure (I-119)", () => {
    const { container } = render(<ToolCallRow part={part("shell", "rejected")} />);
    expect(container.querySelector(".pi-tone-icon")?.getAttribute("data-tone")).toBe("shell");
    expect(container.textContent).toContain("Rejected");
    expect(screen.queryByLabelText("Failed")).toBeNull();
    expect(toolCallStatus(call("shell", {}, { id: "r" }), { toolCallId: "r", toolName: "x", status: "error", output: "", rejected: true }, false)).toBe("rejected");
  });

  it("picks the running call's kind for a group's shimmer", () => {
    expect(currentKind([part("shell", "done", "a"), part("read", "running", "b"), part("edit", "pending", "c")])).toBe("read");
    expect(currentKind([part("shell", "done", "a"), part("edit", "streaming", "c")])).toBe("edit");
    expect(currentKind([part("shell", "done", "a")])).toBeNull();
  });

  it("lists a group's distinct kinds in order, write counting as edit", () => {
    expect(groupKinds([part("shell", "done", "a"), part("write", "done", "b"), part("edit", "done", "c"), part("shell", "done", "d")])).toEqual(["shell", "edit"]);
  });

  it("shows the group's kinds and shimmers its label only while running", () => {
    const group = (calls: ToolCallPart[]): ToolGroupPart => ({
      type: "toolGroup",
      key: "g",
      calls,
      items: calls,
      active: calls.some((c) => c.status === "running"),
      errorCount: 0,
    });
    const { container, rerender } = render(<ToolGroup part={group([part("shell", "done", "a"), part("read", "running", "b")])} />);
    expect(container.querySelector("[data-tone=read] .pi-tone-shimmer, .pi-tone-shimmer")).not.toBeNull();
    expect(container.querySelector(".pi-tone-shimmer")?.closest("[data-tone]")?.getAttribute("data-tone")).toBe("read");
    rerender(<ToolGroup part={group([part("shell", "done", "a"), part("read", "done", "b")])} />);
    expect(container.querySelector(".pi-tone-shimmer")).toBeNull();
    expect(Array.from(container.querySelectorAll(".pi-tone-icon.size-4")).map((e) => e.getAttribute("data-tone"))).toEqual(["shell", "read"]);
  });
});

describe("dominantKind (I-088)", () => {
  const part = (kind: ToolKind, status: ToolCallPart["status"], id: string = kind): ToolCallPart => ({
    type: "tool",
    key: id,
    call: call(kind, {}, { id }),
    result: undefined,
    status,
  });
  it("colours a finished group by the kind most of its calls used", () => {
    expect(dominantKind([part("shell", "done", "a"), part("read", "done", "b"), part("shell", "done", "c")])).toBe("shell");
    expect(dominantKind([part("write", "done", "a"), part("edit", "done", "b"), part("read", "done", "c")])).toBe("edit");
  });
  it("breaks ties by first use and ignores uncategorised calls", () => {
    expect(dominantKind([part("read", "done", "a"), part("search", "done", "b")])).toBe("read");
    expect(dominantKind([part("other", "done", "a"), part("other", "done", "b"), part("list", "done", "c")])).toBe("list");
    expect(dominantKind([part("other", "done", "a")])).toBeNull();
  });
});

describe("agent tool rows (I-108)", () => {
  const msg = (): ToolCallPart => ({
    type: "tool",
    key: "m1",
    call: call("agent", { agentAction: "message", agentName: "context-bar", description: "OK, go ahead" }, { id: "m1", name: "message_agent", args: { to: "context-bar", text: "OK, **go ahead**" } }),
    result: { toolCallId: "m1", toolName: "message_agent", status: "done", output: "Sent to context-bar." },
    status: "done",
  });
  const links = {
    links: NO_SPAWN_LINKS,
    subagents: [],
    refs: [{ name: "context-bar", sessionId: "s1", displayName: "Kit", color: "teal", spawnedAt: 1 }],
  };

  it("shows the agent's fun name in its colour, role greyed, and the message as Markdown", () => {
    const { container } = render(
      <SpawnLinksContext.Provider value={links}>
        <ToolCallRow part={msg()} />
      </SpawnLinksContext.Provider>,
    );
    expect(container.textContent).toContain("Messaged Kit · context-bar: OK, go ahead");
    expect(container.querySelector('[data-agent-color="teal"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("strong, [data-streamdown=strong]")?.textContent).toBe("go ahead");
    expect(container.textContent).not.toContain('"to"');
  });

  it("falls back to the functional name for unknown agents", () => {
    const { container } = render(<ToolCallRow part={msg()} />);
    expect(container.textContent).toContain("Messaged context-bar: OK, go ahead");
  });
});
