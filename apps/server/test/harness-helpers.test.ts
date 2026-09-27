/**
 * Shared harness helpers: session listener sets (I-069) and titles from `complete` (I-067).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { SessionEvents } from "../src/harness/session-events.js";
import type { AgentHarness } from "../src/harness/types.js";
import { cleanTitle, generateTitleWith, titlePrompt } from "../src/harness/title.js";

describe("SessionEvents", () => {
  it("delivers events and exits, survives throwing listeners and unsubscribes", () => {
    const log = vi.fn();
    const events = new SessionEvents(log);
    const seen: string[] = [];
    events.onEvent(() => {
      throw new Error("bad listener");
    });
    const off = events.onEvent((e) => seen.push(e.type));
    const exits: Array<Error | null> = [];
    events.onExit((err) => exits.push(err));
    events.emit({ type: "run_start" });
    off();
    events.emit({ type: "run_end" });
    events.exit(new Error("gone"));
    expect(seen).toEqual(["run_start"]);
    expect(exits.map((e) => e?.message)).toEqual(["gone"]);
    expect(log).toHaveBeenCalledWith("event listener failed: bad listener");
  });
});

describe("titles", () => {
  it("cleans the reply", () => {
    expect(cleanTitle('\n  "Set up pnpm workspaces."  \nmore')).toBe("Set up pnpm workspaces");
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(titlePrompt("x".repeat(3000))).toContain("x".repeat(2000) + "\n</message>");
  });

  it("uses generateTitle when the harness has it, else complete", async () => {
    const harness = new FakeHarness();
    const options = { firstMessage: "hi", cwd: "/tmp", model: null };
    expect(await generateTitleWith(harness, options)).toBe("Generated: hi");
    const complete = vi.fn(async () => "# A title.");
    const bare: AgentHarness = Object.assign(new FakeHarness(), { generateTitle: undefined, complete });
    expect(await generateTitleWith(bare, options)).toBe("A title");
    expect(complete).toHaveBeenCalledWith({ prompt: titlePrompt("hi"), model: null, cwd: "/tmp" });
    expect(await generateTitleWith(Object.assign(new FakeHarness(), { generateTitle: undefined }), options)).toBeNull();
  });
});
