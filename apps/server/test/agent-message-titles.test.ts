/**
 * I-100: sub-agent reports/messages delivered as prompts (`[agent-teams] …`) aren't the user's
 * words: they don't title a chat (quick or generated title, `/name`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatAgentFinished } from "@glade/protocol";
import type { GenerateTitleOptions } from "../src/harness/types.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let titleCalls: GenerateTitleOptions[];
beforeEach(() => {
  env = createTestEnv();
  titleCalls = [];
  env.harness.generateTitle = async (options) => {
    titleCalls.push(options);
    return "Generated";
  };
});
afterEach(async () => {
  await env.cleanup();
});

describe("agent-teams prompts and titles", () => {
  it("a sub-agent report as a chat's first message doesn't title it", async () => {
    const chat = await newChat(env);
    await env.service.prompt(chat.sid, { text: formatAgentFinished("reviewer", "All good.") });
    await flush(5);
    expect(titleCalls).toHaveLength(0);
    expect(env.store.getSession(chat.sid)?.title).toBe("New chat");
  });

  it("a typed first message still does", async () => {
    const chat = await newChat(env);
    await env.service.prompt(chat.sid, { text: "Fix the login bug" });
    await until(() => titleCalls.length === 1);
    expect(titleCalls[0]!.firstMessage).toBe("Fix the login bug");
  });

  it("/name uses the first message the user typed, not a report", async () => {
    const chat = await newChat(env);
    await env.service.prompt(chat.sid, { text: formatAgentFinished("reviewer", "All good.") });
    await flush(5);
    await env.service.prompt(chat.sid, { text: "Now ship the release" });
    await flush(5);
    titleCalls.length = 0;
    await env.service.generateSessionTitle(chat.sid);
    expect(titleCalls.at(-1)!.firstMessage).toBe("Now ship the release");
  });
});
