/**
 * I-209: the website demo. The scenario player (pure: chunks, diffs, the compiled event order),
 * the scripted edits still applying cleanly to the demo repo in the order the sandbox plays them,
 * the demo harness playing a turn, and demo mode never turning on outside a demo sandbox.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@glade/protocol";
import { harnessMode } from "../src/config.js";
import { DEMO_AGENTS } from "../src/harness/demo/agents.js";
import { DemoHarness } from "../src/harness/demo/demo-harness.js";
import { createDemoHarnesses } from "../src/harness/demo/index.js";
import { chunkText, compileTurn, duration, editDiff, INSTANT_PACE, LIVE_PACE, type DemoAction, type DemoStep } from "../src/harness/demo/player.js";
import { DEMO_SCENARIOS, DEMO_SUBAGENTS, findScenario, subagentForTask, toolsFor } from "../src/harness/demo/scenarios.js";

const ids = () => {
  let n = 0;
  return () => `id${n++}`;
};
const events = (actions: DemoAction[]) => actions.filter((a): a is Extract<DemoAction, { type: "emit" }> => a.type === "emit").map((a) => a.event);

describe("chunkText", () => {
  it("splits into small chunks that add up to the text", () => {
    const text = "Checks now retry before they count as down, so a single slow response no longer flips the state.";
    const chunks = chunkText(text, 6);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(10);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(12);
  });
  it("cuts very long words", () => {
    expect(chunkText("x".repeat(40), 6).every((c) => c.length <= 6)).toBe(true);
  });
});

describe("editDiff", () => {
  const file = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
  it("numbers lines and keeps 3 lines of context, with gaps around", () => {
    const diff = editDiff(file, { oldText: "e", newText: "E1\nE2" });
    expect(diff[0]).toEqual({ type: "gap", text: "" });
    expect(diff.filter((l) => l.type === "context").map((l) => l.text)).toEqual(["b", "c", "d", "f", "g", "h"]);
    expect(diff.find((l) => l.type === "del")).toEqual({ type: "del", text: "e", oldLine: 5 });
    expect(diff.filter((l) => l.type === "add")).toEqual([
      { type: "add", text: "E1", newLine: 5 },
      { type: "add", text: "E2", newLine: 6 },
    ]);
    // Lines after the change shift by one in the new file.
    expect(diff.find((l) => l.text === "f")).toMatchObject({ oldLine: 6, newLine: 7 });
    expect(diff.at(-1)).toEqual({ type: "gap", text: "" });
  });
  it("shows shared leading lines as context, not churn", () => {
    const diff = editDiff(file, { oldText: "c\nd", newText: "c\nD" });
    expect(diff.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["d"]);
    expect(diff.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["D"]);
  });
  it("falls back to a plain replacement when the text isn't in the file", () => {
    expect(editDiff(null, { oldText: "x", newText: "y" })).toEqual([
      { type: "del", text: "x", oldLine: 1 },
      { type: "add", text: "y", newLine: 1 },
    ]);
  });
});

describe("compileTurn", () => {
  const files = { "src/a.ts": "one\ntwo\nthree\n" } as Record<string, string>;
  const read = { read: (p: string) => files[p] ?? null };
  const steps: DemoStep[] = [
    { think: "Plan the change." },
    {
      tools: [
        { kind: "read", name: "read", input: { path: "src/a.ts" }, ms: 500 },
        { kind: "edit", name: "edit", input: { path: "src/a.ts", edits: [{ oldText: "two", newText: "TWO" }] }, ms: 200 },
      ],
    },
    { tools: [{ kind: "edit", name: "edit", input: { path: "src/a.ts", edits: [{ oldText: "TWO", newText: "2" }] } }] },
    { spawn: [{ name: "docs", task: "Write the docs." }] },
    { say: "Done." },
  ];

  it("plays thinking, tool calls (finishing shortest first), effects before their tool ends, then the answer", () => {
    const actions = compileTurn(steps, { nextId: ids(), files: read, pace: LIVE_PACE });
    const types = events(actions).map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("block_delta");
    const ends = events(actions).filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
    expect(ends.map((e) => e.result.toolName)).toEqual(["edit", "read", "edit", "spawn_agent"]);
    // The read's output is the file with numbered window; the first edit's diff is real.
    expect(ends[1]!.result.output).toBe("one\ntwo\nthree\n");
    expect(ends[0]!.result.diff?.find((l) => l.type === "add")).toMatchObject({ text: "TWO", newLine: 2 });
    // The second edit sees the first one (in-turn overlay).
    expect(ends[2]!.result.diff?.find((l) => l.type === "del")).toMatchObject({ text: "TWO" });
    const writeAt = actions.findIndex((a) => a.type === "write");
    const firstEnd = actions.findIndex((a) => a.type === "emit" && a.event.type === "tool_end");
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(firstEnd);
    expect(actions.filter((a) => a.type === "write").map((a) => (a as { content: string }).content)).toEqual(["one\nTWO\nthree\n", "one\n2\nthree\n"]);
    expect(actions.some((a) => a.type === "spawn" && a.name === "docs")).toBe(true);
    // Messages close with the right stop reasons; the last one is the answer.
    const ends2 = events(actions).filter((e): e is Extract<AgentEvent, { type: "message_end" }> => e.type === "message_end");
    expect(ends2.map((e) => (e.message.role === "assistant" ? e.message.stopReason : null))).toEqual(["toolUse", "toolUse", "toolUse", "stop"]);
    expect(duration(actions)).toBeGreaterThan(1000);
  });

  it("has no waits at the instant (seeding) pace", () => {
    const actions = compileTurn(steps, { nextId: ids(), files: read, pace: INSTANT_PACE });
    expect(actions.some((a) => a.type === "wait")).toBe(false);
  });

  it("reports with a report_done call", () => {
    const actions = compileTurn([{ report: "All good." }], { nextId: ids(), files: read, pace: INSTANT_PACE });
    expect(actions.find((a) => a.type === "report")).toEqual({ type: "report", summary: "All good." });
  });
});

describe("the demo's scripts", () => {
  const repoDir = fileURLToPath(new URL("../../../scripts/sandbox/demo/repos/lantern/", import.meta.url));
  const readRepo = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else out[relative(repoDir, path)] = readFileSync(path, "utf8");
      }
    };
    walk(repoDir);
    return out;
  };
  /** Plays scenarios in the order the sandbox and the captures do, applying their edits. */
  const play = (files: Record<string, string>, keys: string[]) => {
    const missing: string[] = [];
    for (const key of keys) {
      const scenario = DEMO_SCENARIOS.find((s) => s.id === key) ?? DEMO_SUBAGENTS.find((s) => s.name === key);
      if (!scenario) throw new Error(`no script ${key}`);
      const t = toolsFor(DEMO_AGENTS[("agent" in scenario && scenario.agent) || "pi"]);
      const steps = [...scenario.steps(t), ...("afterReports" in scenario && scenario.afterReports ? scenario.afterReports(t) : [])];
      for (const step of steps) {
        if (!("tools" in step)) continue;
        for (const tool of step.tools) {
          const path = tool.input.path!;
          if (tool.kind === "write") files[path] = tool.input.content!;
          if (tool.kind !== "edit") continue;
          for (const edit of tool.input.edits!) {
            if (!files[path]?.includes(edit.oldText)) missing.push(`${key}: ${path}: ${edit.oldText.slice(0, 60)}`);
            else files[path] = files[path]!.replace(edit.oldText, edit.newText);
          }
        }
      }
    }
    return missing;
  };

  it("edit the Lantern repo cleanly in the order they're played", () => {
    const files = readRepo();
    expect(play(files, ["retries", "audit-fix", "chart", "region"])).toEqual([]);
    // The worktree chat starts from that state; the captures continue on main.
    expect(play({ ...files }, ["discord"])).toEqual([]);
    expect(play(files, ["overlap", "jitter", "docs", "tests", "server-tests"])).toEqual([]);
  });

  it("find scenarios by prompt and agent, and sub-agents by task", () => {
    expect(findScenario("The uptime chart flickers every time a new data point arrives.", "claude")?.id).toBe("chart");
    expect(findScenario("The uptime chart flickers every time a new data point arrives.", "pi")).toBeNull();
    expect(findScenario("Hello there", "pi")).toBeNull();
    const audit = DEMO_SCENARIOS.find((s) => s.id === "audit")!;
    const spawn = audit.steps(toolsFor(DEMO_AGENTS.pi)).find((s) => "spawn" in s) as { spawn: Array<{ name: string; task: string }> };
    for (const agent of spawn.spawn) expect(subagentForTask(agent.task)?.name).toBe(agent.name);
  });
});

describe("DemoHarness", () => {
  it("registers pi, Claude Code and Codex with their real ids and labels", () => {
    expect(createDemoHarnesses().map((h) => [h.id, h.info.label])).toEqual([
      ["pi", "pi"],
      ["claude", "Claude Code"],
      ["codex", "Codex"],
    ]);
  });

  it("plays a scenario as a run, never an echo", async () => {
    const harness = new DemoHarness(DEMO_AGENTS.codex, { livePace: INSTANT_PACE, historyPace: INSTANT_PACE });
    const session = await harness.openSession({ cwd: "/nonexistent-demo-folder", sessionRef: null });
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push(e));
    const text = "AbortSignal.timeout vs an AbortController with setTimeout: which should Lantern use?";
    await session.prompt({ text });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen[0]).toEqual({ type: "run_start" });
    expect(seen.at(-1)).toEqual({ type: "run_end" });
    const transcript = await session.loadTranscript();
    const reply = transcript.messages.at(-1)!;
    expect(reply.role).toBe("assistant");
    const said = reply.role === "assistant" ? reply.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
    expect(said).toContain("AbortSignal.timeout");
    expect(said).not.toContain(text);
    expect(await harness.generateTitle({ firstMessage: text, cwd: "/", model: null })).toBe("AbortSignal.timeout vs a manual timer");
  });
});

describe("harnessMode (demo mode only in demo sandboxes)", () => {
  const quiet = () => {};
  it("is demo only with GLADE_HARNESS=demo, a sandbox and a temporary data folder", () => {
    expect(harnessMode({ GLADE_HARNESS: "demo", GLADE_SANDBOX: "demo", GLADE_DATA_DIR: "/tmp/glade-sandbox/demo/data" }, quiet)).toBe("demo");
  });
  it("runs the real agents otherwise, with a warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(harnessMode({ GLADE_HARNESS: "demo" }, warn)).toBe("pi");
    expect(harnessMode({ GLADE_HARNESS: "demo", GLADE_SANDBOX: "demo" }, warn)).toBe("pi");
    expect(harnessMode({ GLADE_HARNESS: "demo", GLADE_SANDBOX: "demo", GLADE_DATA_DIR: "/Users/someone/Library/Application Support/Glade" }, warn)).toBe("pi");
    expect(harnessMode({ GLADE_HARNESS: "demo", GLADE_DATA_DIR: "/tmp/x" }, warn)).toBe("pi");
    expect(warnings).toHaveLength(4);
  });
  it("leaves the other modes alone", () => {
    expect(harnessMode({}, quiet)).toBe("pi");
    expect(harnessMode({ GLADE_HARNESS: "fake" }, quiet)).toBe("fake");
    expect(harnessMode({ GLADE_HARNESS: "pi" }, quiet)).toBe("pi");
  });
});
