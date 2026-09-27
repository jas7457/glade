/**
 * Real-pi smoke test (costs a few tokens). Run with:
 *   pnpm --filter @glade/server exec tsx scripts/smoke-pi.ts
 *
 * Lists models, opens a session in a temp dir with claude-haiku-4-5 (thinking off), sends one
 * prompt, prints the translated events and asserts the reply, checks title generation (via `complete`), then
 * deletes the session.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentEvent, emptyTranscript, messageText, type AgentEvent } from "@glade/protocol";
import { PiHarness } from "../src/harness/pi/pi-harness.js";
import { generateTitleWith } from "../src/harness/title.js";

const dir = mkdtempSync(join(tmpdir(), "glade-smoke-"));
const harness = new PiHarness({
  config: () => ({ piPath: process.env.PI_PATH ?? "pi", extraArgs: [], autoCompaction: true, autoRetry: true }),
  utilityCwd: dir,
  log: (m) => console.error(`  [log] ${m.slice(0, 200)}`),
});

function summarize(e: AgentEvent): string {
  switch (e.type) {
    case "block_delta":
      return `block_delta ${JSON.stringify(e.delta)}`;
    case "message_start":
    case "message_end":
      return `${e.type} ${e.message.role} ${e.message.id} ${JSON.stringify(messageText(e.message)).slice(0, 80)}`;
    default:
      return JSON.stringify(e).slice(0, 160);
  }
}

async function main(): Promise<void> {
  const models = await harness.listModels();
  console.log(`listModels: ${models.length} models, e.g. ${models.slice(0, 3).map((m) => `${m.provider}/${m.id}`).join(", ")}`);
  assert.ok(models.length > 0, "expected models");

  const session = await harness.openSession({
    cwd: dir,
    sessionRef: null,
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    thinkingLevel: "off",
  });
  console.log(`session: ${session.sessionRef}`);
  console.log(`state: ${JSON.stringify(session.getState())}`);

  let transcript = emptyTranscript();
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for run_end")), 90_000);
    session.onEvent((e) => {
      console.log(`  event: ${summarize(e)}`);
      transcript = applyAgentEvent(transcript, e);
      if (e.type === "run_end") {
        clearTimeout(timer);
        resolve();
      }
    });
    session.onExit((err) => err && reject(err));
  });
  await session.prompt({ text: "Reply with exactly: pong" });
  await done;

  const last = transcript.messages.at(-1);
  assert.ok(last && last.role === "assistant", "last message should be from the assistant");
  assert.match(messageText(last), /pong/i);
  console.log(`final: ${JSON.stringify(messageText(last))}`);

  const history = await session.loadTranscript();
  assert.deepEqual(
    history.messages.map((m) => m.role),
    transcript.messages.map((m) => m.role),
    "get_messages should match the live transcript",
  );

  const title = await generateTitleWith(harness, {
    firstMessage: "How do I set up a pnpm monorepo with vitest?",
    cwd: dir,
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
  });
  console.log(`generateTitle: ${JSON.stringify(title)}`);
  assert.ok(title, "expected a generated title");

  const ref = session.sessionRef;
  await session.dispose();
  if (ref) await harness.deleteSession(ref);
  console.log("OK");
}

main()
  .catch((err) => {
    console.error("SMOKE TEST FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
