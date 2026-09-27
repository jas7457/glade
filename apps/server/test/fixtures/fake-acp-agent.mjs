#!/usr/bin/env node
/**
 * A scripted fake ACP agent for tests (I-119): speaks ACP (newline-delimited JSON-RPC 2.0) on
 * stdio with canned behaviour. No model, no network, no dependencies. Hand-written (not the SDK)
 * so the tests check Glade's client against the wire format itself.
 *
 * What a prompt does depends on its text (first word):
 *   hello            thought + two text chunks, end_turn (with usage)
 *   tool             tool_call (execute, pending) → update in_progress → completed with output, then text
 *   edit <path>      tool_call (edit) with a diff, completed
 *   plan             a plan, updated once
 *   permission       asks permission for a tool call; answers with the chosen option id
 *   read <path>      fs/read_text_file; says what it got (or the error)
 *   write <path> <text…>  fs/write_text_file; says ok (or the error)
 *   wait             streams a chunk, then waits for session/cancel → stopReason cancelled
 *   ignore-cancel    like wait, but never answers after a cancel
 *   error            answers the prompt with a JSON-RPC error
 *   refuse           stopReason refusal
 *   crash            exits with code 3 mid-turn
 *   slow             answers after 150 ms
 *   history          says how many prompts this session has seen (proves session/load kept it)
 *
 * Environment:
 *   FAKE_ACP_LOAD=1   advertise loadSession; session/load replays the history as updates
 *   FAKE_ACP_RESUME=1 advertise sessionCapabilities.resume
 *   FAKE_ACP_AUTH=1   session/new fails with auth_required (-32000)
 *   FAKE_ACP_LOG=<file>  append every received message (JSON per line) for assertions
 *   FAKE_ACP_STATE=<file> persist sessions here (so a restarted agent can load them)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const log = (msg) => env.FAKE_ACP_LOG && appendFileSync(env.FAKE_ACP_LOG, JSON.stringify(msg) + "\n");

/** sessionId → { cwd, history: [{ role, text }] } */
const sessions = env.FAKE_ACP_STATE && existsSync(env.FAKE_ACP_STATE) ? JSON.parse(readFileSync(env.FAKE_ACP_STATE, "utf8")) : {};
const save = () => env.FAKE_ACP_STATE && writeFileSync(env.FAKE_ACP_STATE, JSON.stringify(sessions));

let nextRequestId = 1;
const waiting = new Map(); // our request id → resolve
const cancelled = new Set(); // session ids with a pending cancel
const cancelWaiters = new Map(); // session id → resolve

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const respond = (id, result) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const text = (sessionId, t) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(msg) {
  log(msg);
  if (msg.method === undefined) {
    // A response to one of our requests.
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve?.(msg);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: env.FAKE_ACP_LOAD === "1",
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          ...(env.FAKE_ACP_RESUME === "1" ? { sessionCapabilities: { resume: {} } } : {}),
        },
        authMethods: [],
        agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      });
    case "session/new": {
      if (env.FAKE_ACP_AUTH === "1") return fail(id, -32000, "Authentication required");
      const sessionId = `fake-${Object.keys(sessions).length + 1}-${process.pid}`;
      sessions[sessionId] = { cwd: params.cwd, history: [] };
      save();
      respond(id, { sessionId, modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] } });
      update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review the changes", input: { hint: "[focus]" } }] });
      return;
    }
    case "session/load":
    case "session/resume": {
      const session = sessions[params.sessionId];
      if (!session) return fail(id, -32002, "Resource not found", { uri: params.sessionId });
      if (method === "session/load") {
        for (const h of session.history) {
          update(params.sessionId, { sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } });
        }
      }
      return respond(id, {});
    }
    case "session/cancel": {
      cancelled.add(params.sessionId);
      cancelWaiters.get(params.sessionId)?.();
      return;
    }
    case "session/prompt":
      return prompt(id, params);
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
}

async function prompt(id, { sessionId, prompt }) {
  const session = sessions[sessionId];
  if (!session) return fail(id, -32602, "Unknown session");
  cancelled.delete(sessionId);
  const input = prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const [word, ...rest] = input.trim().split(/\s+/);
  session.history.push({ role: "user", text: input });
  let reply = "";
  const say = (t) => {
    reply += t;
    text(sessionId, t);
  };
  const done = (stopReason = "end_turn", usage) => {
    session.history.push({ role: "assistant", text: reply });
    save();
    respond(id, { stopReason, ...(usage ? { usage } : {}) });
  };

  switch (word) {
    case "hello":
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it" } });
      say("Hello ");
      say("there!");
      update(sessionId, { sessionUpdate: "usage_update", used: 5000, size: 100000, cost: { amount: 0.01, currency: "USD" } });
      return done("end_turn", { totalTokens: 30, inputTokens: 20, outputTokens: 10 });
    case "tool":
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file-a\nfile-b" } }],
      });
      say("Listed.");
      return done();
    case "edit":
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "e1",
        title: `Edit ${rest[0]}`,
        kind: "edit",
        status: "in_progress",
        locations: [{ path: rest[0] }],
        content: [{ type: "diff", path: rest[0], oldText: "old line", newText: "new line" }],
      });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" });
      return done();
    case "plan":
      update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Step one", priority: "high", status: "in_progress" }, { content: "Step two", priority: "low", status: "pending" }] });
      update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Step one", priority: "high", status: "completed" }, { content: "Step two", priority: "low", status: "in_progress" }] });
      say("Planned.");
      return done();
    case "permission": {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "p1", title: "Delete build/", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
      const answer = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "p1" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = answer.result?.outcome;
      if (outcome?.outcome === "cancelled" || cancelled.has(sessionId)) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "p1", status: "failed" });
        return done("cancelled");
      }
      const allowed = outcome.optionId !== "reject";
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "p1", status: allowed ? "completed" : "failed" });
      say(`chose:${outcome.optionId}`);
      return done();
    }
    case "read": {
      const answer = await request("fs/read_text_file", { sessionId, path: rest[0], ...(rest[1] ? { line: Number(rest[1]), limit: Number(rest[2] ?? 1) } : {}) });
      say(answer.error ? `read-error:${answer.error.message}` : `read:${answer.result.content}`);
      return done();
    }
    case "write": {
      const answer = await request("fs/write_text_file", { sessionId, path: rest[0], content: rest.slice(1).join(" ") });
      say(answer.error ? `write-error:${answer.error.message}` : "write:ok");
      return done();
    }
    case "wait":
    case "ignore-cancel": {
      say("Working…");
      await new Promise((resolve) => {
        if (cancelled.has(sessionId)) return resolve();
        cancelWaiters.set(sessionId, resolve);
      });
      cancelWaiters.delete(sessionId);
      if (word === "ignore-cancel") return; // never answers
      return done("cancelled");
    }
    case "error":
      session.history.pop();
      return fail(id, -32603, "Internal error", "model overloaded");
    case "refuse":
      return done("refusal");
    case "crash":
      say("about to crash");
      process.stderr.write("fatal: fake crash\n");
      setTimeout(() => process.exit(3), 20);
      return;
    case "slow":
      await new Promise((r) => setTimeout(r, 150));
      say("slow done");
      return done();
    case "history":
      say(`seen:${session.history.filter((h) => h.role === "user").length}`);
      return done();
    default:
      say(`echo:${input}`);
      return done();
  }
}
