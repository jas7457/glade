/**
 * The chat title is re-applied every time a chat's pi process starts; pi's `set_session_name`
 * appends a `session_info` entry each call, so PiSession skips it when pi already has that name.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PiSession } from "../src/harness/pi/pi-harness.js";
import type { PiRpcProcess } from "../src/harness/pi/rpc-process.js";

class StubProc extends EventEmitter {
  readonly calls: Array<Record<string, unknown>> = [];
  constructor(private readonly state: Record<string, unknown>) {
    super();
  }
  request(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    this.calls.push(command);
    if (command.type === "get_state") return Promise.resolve(this.state);
    return Promise.resolve({});
  }
  names(): unknown[] {
    return this.calls.filter((c) => c.type === "set_session_name").map((c) => c.name);
  }
}

async function started(state: Record<string, unknown>) {
  const proc = new StubProc({ sessionFile: "/s.jsonl", ...state });
  const session = new PiSession(proc as unknown as PiRpcProcess, undefined, "/project", () => "/exports");
  await session.init({ autoCompaction: true, autoRetry: true });
  return { proc, session };
}

describe("PiSession.setTitle", () => {
  it("doesn't re-send the name pi already has (get_state.sessionName)", async () => {
    const { proc, session } = await started({ sessionName: "Planning work" });
    await session.setTitle("Planning work");
    expect(proc.names()).toEqual([]);
  });

  it("sends new or changed names once", async () => {
    const { proc, session } = await started({});
    await session.setTitle("Planning work");
    await session.setTitle("Planning work");
    await session.setTitle("Renamed");
    expect(proc.names()).toEqual(["Planning work", "Renamed"]);
  });
});
