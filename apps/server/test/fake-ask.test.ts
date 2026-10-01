/**
 * I-193: the fake harness's `ask …` prompts put a question (select / confirm / input) to the user,
 * wait for the answer and reply with it, so voice mode's spoken questions can be tried without a
 * model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultFakeScript } from "../src/harness/fake/fake-harness.js";
import { createTestEnv, flush, newChat, type TestEnv } from "./helpers.js";

async function until(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await flush(2);
  }
}

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
  env.harness.script = defaultFakeScript;
});
afterEach(async () => {
  await env.cleanup();
});

describe("fake harness: ask (I-193)", () => {
  it("asks a select question and replies with the answer", async () => {
    const { sid } = await newChat(env, { prompt: "ask select Which database? | PostgreSQL | SQLite" });
    await until(async () => (await env.service.getSessionDetail(sid)).pendingUiRequests.length === 1);
    const detail = await env.service.getSessionDetail(sid);
    const [question] = detail.pendingUiRequests;
    expect(question).toMatchObject({ kind: "select", title: "Which database?", options: ["PostgreSQL", "SQLite"] });
    expect(detail.state.isRunning).toBe(true);
    env.service.respondToUi(sid, { id: question!.id, value: "SQLite" });
    await until(async () => !(await env.service.getSessionDetail(sid)).state.isRunning);
    const after = await env.service.getSessionDetail(sid);
    expect(after.pendingUiRequests).toEqual([]);
    const last = after.transcript.messages.at(-1)!;
    expect(last.role === "assistant" && last.content[0]).toMatchObject({ type: "text", text: "You picked: SQLite" });
  });

  it("asks a confirm question", async () => {
    const { sid } = await newChat(env, { prompt: "ask confirm Delete the branch? | feature/x is merged" });
    await until(async () => (await env.service.getSessionDetail(sid)).pendingUiRequests.length === 1);
    const [confirm] = (await env.service.getSessionDetail(sid)).pendingUiRequests;
    expect(confirm).toMatchObject({ kind: "confirm", title: "Delete the branch?", message: "feature/x is merged" });
    env.service.respondToUi(sid, { id: confirm!.id, confirmed: false });
    await until(async () => !(await env.service.getSessionDetail(sid)).state.isRunning);
    expect(JSON.stringify((await env.service.getSessionDetail(sid)).transcript.messages.at(-1))).toContain("You said no.");
  });
});
