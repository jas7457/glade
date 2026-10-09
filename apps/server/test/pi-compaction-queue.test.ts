/**
 * I-216: messages sent while pi compacts. pi refuses a prompt during a manual compaction, so
 * PiSession holds them (shown as queued follow-ups) and sends them, in order, once it has ended.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@glade/protocol";
import { PiSession } from "../src/harness/pi/pi-harness.js";
import type { PiRpcProcess } from "../src/harness/pi/rpc-process.js";
import { until } from "./helpers.js";

class StubProc extends EventEmitter {
  readonly calls: Array<Record<string, unknown>> = [];
  finishCompact!: () => void;
  constructor(private readonly pi: { compactFails?: boolean } = {}) {
    super();
  }
  request(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    this.calls.push(command);
    if (command.type === "get_state") return Promise.resolve({ sessionFile: "/s.jsonl" });
    if (command.type === "compact") {
      return new Promise((resolve, reject) => {
        this.finishCompact = () => {
          if (this.pi.compactFails) return reject(new Error("boom"));
          // pi clears its compaction state, then emits the end, then answers the request.
          this.emit("event", { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: { tokensBefore: 10, estimatedTokensAfter: 2 } });
          resolve({ tokensBefore: 10, estimatedTokensAfter: 2 });
        };
      });
    }
    return Promise.resolve({});
  }
  prompts(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.type === "prompt");
  }
}

async function started(pi: { compactFails?: boolean } = {}) {
  const proc = new StubProc(pi);
  const session = new PiSession(proc as unknown as PiRpcProcess, undefined, "/project", () => "/exports");
  await session.init();
  const events: AgentEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { proc, session, events };
}

describe("PiSession while compacting (I-216)", () => {
  it("holds prompts sent during a manual compaction and sends them afterwards as follow-ups, in order", async () => {
    const { proc, session } = await started();
    proc.emit("event", { type: "compaction_start", reason: "manual" });
    const compacting = session.compact();
    await until(() => !!proc.finishCompact);
    await session.prompt({ text: "one", behavior: "followUp" });
    await session.prompt({ text: "two", behavior: "steer" });
    expect(proc.prompts()).toEqual([]);
    expect(session.getState().queue.followUp).toEqual(["one", "two"]);
    proc.finishCompact();
    await compacting;
    await until(() => proc.prompts().length === 2);
    expect(proc.prompts().map((p) => [p.message, p.streamingBehavior])).toEqual([
      ["one", "followUp"],
      ["two", "followUp"],
    ]);
    expect(session.getState().queue.followUp).toEqual([]);
  });

  it("also holds before pi has reported the start, and shows pi's own queue first", async () => {
    const { proc, session } = await started();
    proc.emit("event", { type: "queue_update", steering: [], followUp: ["queued in pi"] });
    const compacting = session.compact();
    await session.prompt({ text: "held" });
    expect(proc.prompts()).toEqual([]);
    expect(session.getState().queue.followUp).toEqual(["queued in pi", "held"]);
    await until(() => !!proc.finishCompact);
    proc.finishCompact();
    await compacting;
    await until(() => proc.prompts().length === 1);
  });

  it("sends held prompts when an auto-compaction ends", async () => {
    const { proc, session } = await started();
    proc.emit("event", { type: "compaction_start", reason: "threshold" });
    expect(session.getState().isCompacting).toBe(true);
    await session.prompt({ text: "later", behavior: "followUp" });
    expect(proc.prompts()).toEqual([]);
    proc.emit("event", { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    await until(() => proc.prompts().length === 1);
    expect(proc.prompts()[0]).toMatchObject({ message: "later", streamingBehavior: "followUp" });
  });

  it("sends held prompts even when the compaction request fails", async () => {
    const { proc, session } = await started({ compactFails: true });
    const compacting = session.compact().catch((e: Error) => e.message);
    await until(() => !!proc.finishCompact);
    await session.prompt({ text: "still wanted" });
    proc.finishCompact();
    expect(await compacting).toBe("boom");
    await until(() => proc.prompts().length === 1);
  });

  it("sends prompts straight away when not compacting", async () => {
    const { proc, session } = await started();
    await session.prompt({ text: "now" });
    expect(proc.prompts()).toHaveLength(1);
  });
});
