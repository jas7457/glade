/**
 * I-121: Glade's SQLite store. Migrations, the one-time JSON import, importing pi's JSONL (and
 * re-importing what changed outside Glade), stable message ids, coalesced transcript writes,
 * sub-agent message kinds, the older-server guard and the cleanup of the old JSON files.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageText, type AgentEvent, type ChatMessage, type Session, type Transcript, type Workspace } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { piSessionReader } from "../src/harness/pi/session-reader.js";
import { readPiTranscript } from "../src/harness/pi/transcript-file.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { startBlockedServer } from "../src/http/blocked.js";
import { AppService } from "../src/services/app-service.js";
import { MessageIds, TranscriptWriter } from "../src/services/app/transcript-writer.js";
import { ServerRegistry } from "../src/services/server-registry.js";
import { NewerSchemaError, openDatabase, schemaVersion } from "../src/store/db/database.js";
import { isUlid } from "../src/store/db/ids.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/store/db/migrations/index.js";
import { CLEANUP_AFTER_STARTS, recordSuccessfulStart } from "../src/store/startup.js";
import { Store } from "../src/store/store.js";
import { mergeTranscripts } from "../src/store/transcript-rows.js";
import { until } from "./helpers.js";

const PI_FIXTURE = fileURLToPath(new URL("./fixtures/pi-session-store.jsonl", import.meta.url));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(dataDir: string): Store {
  const store = new Store(dataDir);
  cleanups.push(() => store.dispose());
  return store;
}

const workspace = (id: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  projectId: null,
  title: "Chat",
  titleSource: "auto",
  cwd: "/tmp",
  pinned: false,
  createdAt: 1,
  lastActivityAt: 1,
  layout: null,
  ...extra,
});

const session = (id: string, workspaceId: string, extra: Partial<Session> = {}): Session => ({
  id,
  workspaceId,
  kind: "main",
  parentSessionId: null,
  agentName: null,
  title: "Chat",
  titleSource: "auto",
  harness: "fake",
  sessionRef: null,
  unread: false,
  createdAt: 1,
  lastActivityAt: 1,
  model: null,
  thinkingLevel: null,
  ...extra,
});

const user = (id: string, text: string, timestamp: number): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (id: string, text: string, timestamp: number, extra: object = {}): ChatMessage => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
  ...extra,
});

/** A harness that reads real pi session files (import only), like pi's, but runs the fake agent. */
class PiFileHarness extends FakeHarness {
  constructor() {
    super(undefined, 0, { id: "pifile" });
  }
  override readTranscript = (ref: string) => readPiTranscript(ref);
  statSession = (ref: string) => piSessionReader.stat(ref);
}

describe("database and migrations", () => {
  it("creates the schema and records its version", () => {
    const db = openDatabase(join(tempDir(), "glade.db"));
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["meta", "projects", "workspaces", "sessions", "messages", "tool_results", "transcripts", "agents", "settings", "session_summaries", "events"]));
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    db.close();
  });

  it("applies only newer migrations and refuses a database from a newer Glade", () => {
    const path = join(tempDir(), "glade.db");
    openDatabase(path).close();
    const next = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: "extra", sql: "CREATE TABLE extra (x INTEGER)" }];
    const db = openDatabase(path, next);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION + 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM extra").get()).toEqual({ n: 0 });
    db.close();
    expect(() => openDatabase(path)).toThrow(NewerSchemaError);
  });
});

describe("importing the JSON files (first start)", () => {
  function writeLegacyFolder(dir: string) {
    const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
    write("projects.json", { version: 1, projects: [{ id: "p1", name: "Proj", path: "/p", createdAt: 1, lastActivityAt: 5, pinned: true }] });
    write("workspaces.json", {
      version: 1,
      workspaces: [workspace("w1", { projectId: "p1", pinned: true }), workspace("w2")],
      sessions: [
        session("s1", "w1", { harness: "pi", sessionRef: "/sessions/a.jsonl" }),
        session("s2", "w2", { harness: "acp-gem", sessionRef: "acpref" }),
        session("s3", "w1", { kind: "subagent", parentSessionId: "s1", agentName: "reviewer" }),
      ],
    });
    write("settings.json", { general: { sendKey: "mod-enter" }, agent: { piPath: "/opt/pi" } });
    write("agents.json", {
      version: 1,
      agents: [{ sessionId: "s3", parentSessionId: "s1", workspaceId: "w1", name: "reviewer", agent: null, task: "t", systemPrompt: "role", tools: null, autoClose: true, keepOpenReason: null, userEngaged: false, spawnedAt: 1, doneAt: null, result: null, closing: false, closed: false }],
    });
    write("session-summaries.json", { version: 1, enabledAt: 42, summaries: { s1: { text: "Fixing things.", messageCount: 4, at: 50 } } });
    write("search-index.json", { version: 1, sessions: {} });
    mkdirSync(join(dir, "acp-sessions"));
    write("acp-sessions/acpref.json", {
      version: 1,
      harness: "acp-gem",
      acpSessionId: "gem-123",
      cwd: "/tmp",
      title: "Gem chat",
      createdAt: 1,
      transcript: { messages: [user("u1", "hi gem", 10), assistant("a1", "hello", 11, { streaming: true })], toolResults: {} },
    });
  }

  it("imports everything once, in one go, and leaves the files untouched", () => {
    const dir = tempDir();
    writeLegacyFolder(dir);
    const before = new Map(["projects.json", "workspaces.json", "settings.json", "agents.json", "acp-sessions/acpref.json"].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const store = openStore(dir);

    expect(store.jsonImport?.counts).toEqual({ projects: 1, workspaces: 2, sessions: 3, agents: 1, summaries: 1, acpTranscripts: 1 });
    expect(store.listProjects()).toEqual([{ id: "p1", name: "Proj", path: "/p", createdAt: 1, lastActivityAt: 5, sortOrder: 0 }]);
    expect(store.getWorkspace("w1")?.pinOrder).toBe(0); // I-019 upgrade applied on import
    expect(store.listSessions().map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(store.getSettings().harnesses.pi.piPath).toBe("/opt/pi"); // I-066 upgrade applied
    expect(store.getAgent("s3")?.systemPrompt).toBe("role");
    expect(store.getSummary("s1")?.text).toBe("Fixing things.");
    expect(store.summariesEnabledAt(999)).toBe(42);
    // The ACP copy became stored messages with Glade ids, and its session id the resume cursor.
    const acp = store.loadTranscript("s2", { settle: true });
    expect(acp.messages.map((m) => [m.role, messageText(m)])).toEqual([["user", "hi gem"], ["assistant", "hello"]]);
    expect(acp.messages.every((m) => isUlid(m.id))).toBe(true);
    expect(acp.messages[1]).toMatchObject({ streaming: false });
    expect(store.getResume("s2")).toEqual({ acpSessionId: "gem-123", title: "Gem chat" });
    // Nothing was changed on disk.
    for (const [file, content] of before) expect(readFileSync(join(dir, file), "utf8")).toBe(content);

    // A second start doesn't import again (even if an old server changed a file meanwhile).
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
    const again = openStore(dir);
    expect(again.jsonImport).toBeNull();
    expect(again.listProjects()).toHaveLength(1);
  });

  it("deletes the imported files only after enough successful starts with no older server registered", () => {
    const dir = tempDir();
    writeLegacyFolder(dir);
    writeFileSync(join(dir, "chats.json"), "{broken"); // not read (workspaces.json exists): not in the import, kept
    const store = openStore(dir);
    const old = new ServerRegistry(dir, { kind: "desktop", host: "127.0.0.1", port: 1, id: "old", storeSchema: null, heartbeatMs: 0 });
    old.start();
    const self = new ServerRegistry(dir, { kind: "dev", host: "127.0.0.1", port: 2, id: "self", heartbeatMs: 0 });
    self.start();

    for (let i = 1; i < CLEANUP_AFTER_STARTS; i++) expect(recordSuccessfulStart(store, self).deleted).toEqual([]);
    expect(existsSync(join(dir, "projects.json"))).toBe(true);
    // Confirmed, but an older Glade is registered: kept.
    expect(recordSuccessfulStart(store, self)).toEqual({ starts: CLEANUP_AFTER_STARTS, deleted: [] });
    expect(existsSync(join(dir, "projects.json"))).toBe(true);
    old.release();
    const { deleted } = recordSuccessfulStart(store, self);
    expect(deleted.sort()).toEqual(["acp-sessions", "agents.json", "projects.json", "search-index.json", "session-summaries.json", "settings.json", "workspaces.json"]);
    for (const f of deleted) expect(existsSync(join(dir, f))).toBe(false);
    expect(existsSync(join(dir, "chats.json"))).toBe(true);
    expect(existsSync(join(dir, "glade.db"))).toBe(true);
    // Everything is still there, from the database.
    expect(openStore(dir).listSessions()).toHaveLength(3);
    expect(recordSuccessfulStart(store, self).deleted).toEqual([]); // once
    self.release();
  });
});

describe("older-server guard", () => {
  it("tells servers from before the database apart by their missing store schema", () => {
    const dir = tempDir();
    const self = new ServerRegistry(dir, { kind: "dev", host: "127.0.0.1", port: 0, id: "self", heartbeatMs: 0 });
    self.start();
    const peer = new ServerRegistry(dir, { kind: "desktop", host: "127.0.0.1", port: 0, id: "peer", heartbeatMs: 0 });
    peer.start();
    expect(self.olderServers()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "servers", "self.json"), "utf8")).storeSchema).toBe(SCHEMA_VERSION);
    // An old server's file (no storeSchema), as the JSON-era Glade writes it.
    writeFileSync(join(dir, "servers", `${process.ppid}.json`), JSON.stringify({ id: String(process.ppid), pid: process.ppid, kind: "desktop", host: "127.0.0.1", port: 4327, startedAt: 1, heartbeatAt: Date.now() }));
    expect(self.olderServers().map((s) => s.port)).toEqual([4327]);
    self.release();
    peer.release();
  });

  it("answers with the 'quit the older Glade first' state while blocked", async () => {
    let port = 0;
    const blocked = startBlockedServer("127.0.0.1", 0, "Quit it first", (p) => (port = p));
    cleanups.push(() => blocked.close());
    await until(() => port > 0);
    const api = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: "Quit it first", code: "older_server" });
    expect((await fetch(`http://127.0.0.1:${port}/api/settings`)).status).toBe(200); // the desktop app opens its window
    const page = await (await fetch(`http://127.0.0.1:${port}/chats/x`)).text();
    expect(page).toContain("Quit the older Glade first");
    expect(page).toContain("Quit it first");
  });
});

describe("conversations in the store", () => {
  function service(dataDir: string, harness: FakeHarness) {
    const store = new Store(dataDir, 0);
    const svc = new AppService({ store, harnesses: new HarnessRegistry([harness]), scratchDir: join(dataDir, "..", "scratch") });
    cleanups.push(() => svc.dispose());
    return { store, service: svc };
  }

  it("gives messages stable Glade ids: live events, the store and a restarted server agree", async () => {
    const dir = tempDir();
    const first = service(join(dir, "data"), new FakeHarness());
    const events: AgentEvent[] = [];
    first.service.subscribe((m) => m.type === "session_event" && events.push(m.event));
    const created = await first.service.createWorkspace({ projectId: null, prompt: "hello there" });
    const sid = created.session.session.id;
    await until(() => !first.service.listSessions()[0]!.running);
    const live = (await first.service.getSessionDetail(sid)).transcript;
    expect(live.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(live.messages.every((m) => isUlid(m.id))).toBe(true);
    // Every pushed event used the same ids (no harness ids leak out).
    const pushed = new Set(events.flatMap((e) => (e.type === "message_start" || e.type === "message_end" ? [e.message.id] : e.type.startsWith("block_") ? [(e as { messageId: string }).messageId] : [])));
    expect([...pushed].sort()).toEqual(live.messages.map((m) => m.id).sort());
    await first.service.dispose();

    // A new server with a fresh harness (nothing in its memory): the store is the source.
    const second = service(join(dir, "data"), new FakeHarness());
    const reloaded = (await second.service.getSessionDetail(sid)).transcript;
    expect(reloaded.messages.map((m) => m.id)).toEqual(live.messages.map((m) => m.id));
    expect(reloaded.messages.map((m) => messageText(m))).toEqual(live.messages.map((m) => messageText(m)));
    expect(Object.keys(reloaded.toolResults)).toEqual(Object.keys(live.toolResults));
    // Continuing appends after the stored history.
    await second.service.prompt(sid, { text: "again" });
    await until(() => second.store.loadTranscript(sid).messages.length === 6);
    expect(second.store.loadTranscript(sid).messages.slice(0, 3).map((m) => m.id)).toEqual(live.messages.map((m) => m.id));
    // Searchable text and chat tools read the store.
    expect((await second.service.readSessionText(sid))?.messages.map((m) => m.text)).toEqual(["hello there", "You said: hello there", "again", "You said: again"]);
  });

  it("imports pi's JSONL (read-only), keeps ids, and merges turns added outside Glade", async () => {
    const dir = tempDir();
    const file = join(dir, "pi", "session.jsonl");
    mkdirSync(join(dir, "pi"));
    copyFileSync(PI_FIXTURE, file);
    const harness = new PiFileHarness();
    const { store, service: svc } = service(join(dir, "data"), harness);
    store.upsertWorkspace(workspace("w1"));
    store.upsertSession(session("s1", "w1", { harness: "pifile", sessionRef: file, createdAt: 5 }));
    store.upsertSession(session("s0", "w1", { harness: "pifile", sessionRef: join(dir, "pi", "missing.jsonl"), createdAt: 1 }));
    const original = readFileSync(file, "utf8");

    const summary = await svc.startTranscriptImport();
    expect(summary).toMatchObject({ sessions: 2, imported: 1, messages: 5 });
    const imported = store.loadTranscript("s1");
    expect(imported.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(imported.messages.every((m) => isUlid(m.id))).toBe(true);
    expect(imported.toolResults.call_1).toMatchObject({ status: "done", output: "README.md\nsrc\n" });
    expect(readFileSync(file, "utf8")).toBe(original); // never modified
    // A delivered sub-agent report is stored as its own kind (the text is unchanged).
    const kinds = store.db.prepare("SELECT kind, meta_json FROM messages WHERE session_id = 's1' AND kind IS NOT NULL").all();
    expect(kinds).toEqual([{ kind: "agent_message", meta_json: JSON.stringify({ kind: "finished", from: "reviewer", to: "main" }) }]);

    // Unchanged file: nothing to do.
    expect(await svc.startTranscriptImport()).toBe(summary); // one background job per server
    expect(store.transcriptInfo("s1")?.version).toBe(1);

    // pi resumed in a terminal appends a turn: reading the chat merges it, keeping existing ids.
    appendFileSync(
      file,
      [
        JSON.stringify({ type: "message", id: "b1", parentId: "a7", message: { role: "user", content: [{ type: "text", text: "one more thing" }], timestamp: 1788000010000 } }),
        JSON.stringify({ type: "message", id: "b2", parentId: "b1", message: { role: "assistant", content: [{ type: "text", text: "Sure." }], timestamp: 1788000011000, stopReason: "stop" } }),
      ].join("\n") + "\n",
    );
    const text = await svc.readSessionText("s1");
    expect(text?.messages.slice(-2).map((m) => m.text)).toEqual(["one more thing", "Sure."]);
    const merged = store.loadTranscript("s1");
    expect(merged.messages.slice(0, 5).map((m) => m.id)).toEqual(imported.messages.map((m) => m.id));
    expect(merged.messages).toHaveLength(7);

    // Opening it shows the store's copy (not a second translation of pi's history).
    const detail = await svc.getSessionDetail("s1");
    expect(detail.transcript.messages.map((m) => m.id)).toEqual(merged.messages.map((m) => m.id));
  });

  it("merges a pi file changed outside Glade on the next open, even when the store already had the session", async () => {
    const dir = tempDir();
    const dataDir = join(dir, "data");
    mkdirSync(join(dir, "pi"));
    const file = join(dir, "pi", "session.jsonl");
    const setup = service(dataDir, new PiFileHarness());
    setup.store.upsertWorkspace(workspace("w1"));
    setup.store.upsertSession(session("s1", "w1", { harness: "pifile", sessionRef: file }));
    // Opened once before pi wrote anything: the store knows it (source live, 0 messages).
    expect((await setup.service.getSessionDetail("s1")).transcript.messages).toEqual([]);
    expect(setup.store.transcriptInfo("s1")).toMatchObject({ source: "live", messageCount: 0, sourceSig: null });
    // The session continues in a terminal, then the server restarts (shutdown doesn't mark it seen).
    copyFileSync(PI_FIXTURE, file);
    await setup.service.dispose();
    const next = service(dataDir, new PiFileHarness());
    const detail = await next.service.getSessionDetail("s1");
    expect(detail.transcript.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(next.store.transcriptInfo("s1")?.sourceSig).not.toBeNull();
  });

  it("merges outside changes when a live process stops, and Glade's own turns never come back twice", async () => {
    const dir = tempDir();
    const dataDir = join(dir, "data");
    mkdirSync(join(dir, "pi"));
    const file = join(dir, "pi", "session.jsonl");
    copyFileSync(PI_FIXTURE, file);
    const harness = new PiFileHarness();
    const first = service(dataDir, harness);
    first.store.upsertWorkspace(workspace("w1"));
    first.store.upsertSession(session("s1", "w1", { harness: "pifile", sessionRef: file }));
    const closeLive = (svc: AppService, id: string) => (svc as unknown as { closeLive(id: string): Promise<void> }).closeLive(id);
    const piLine = (id: string, parentId: string, message: object) => JSON.stringify({ type: "message", id, parentId, message }) + "\n";

    expect((await first.service.getSessionDetail("s1")).transcript.messages).toHaveLength(5);
    // Glade's own run: streamed live (stored), and pi appends the same turns to its file.
    const fake = [...harness.openSessions].find((x) => x.sessionRef === file)!;
    const t = 1788000020000;
    fake.emit({ type: "run_start" });
    fake.emit({ type: "message_start", message: user("u", "own turn", t) });
    fake.emit({ type: "message_end", message: user("u", "own turn", t) });
    fake.emit({ type: "message_start", message: assistant("a", "", t + 1, { streaming: true }) });
    fake.emit({ type: "message_end", message: assistant("a", "own answer", t + 1, { stopReason: "stop" }) });
    fake.emit({ type: "run_end" });
    appendFileSync(file, piLine("c1", "a7", { role: "user", content: [{ type: "text", text: "own turn" }], timestamp: t }));
    appendFileSync(file, piLine("c2", "c1", { role: "assistant", content: [{ type: "text", text: "own answer" }], timestamp: t + 1, stopReason: "stop" }));
    await closeLive(first.service, "s1");
    const own = first.store.loadTranscript("s1");
    expect(own.messages.map((m) => messageText(m)).slice(-2)).toEqual(["own turn", "own answer"]);
    expect(own.messages).toHaveLength(7);

    // Reopening after a restart: nothing duplicated, same ids.
    await first.service.dispose();
    const second = service(dataDir, new PiFileHarness());
    expect((await second.service.getSessionDetail("s1")).transcript.messages.map((m) => m.id)).toEqual(own.messages.map((m) => m.id));

    // Turns added outside Glade while it's live here: merged once when the process stops, kept once after.
    appendFileSync(file, piLine("d1", "c2", { role: "user", content: [{ type: "text", text: "from the terminal" }], timestamp: t + 10 }));
    appendFileSync(file, piLine("d2", "d1", { role: "assistant", content: [{ type: "text", text: "terminal answer" }], timestamp: t + 11, stopReason: "stop" }));
    await closeLive(second.service, "s1");
    const merged = second.store.loadTranscript("s1");
    expect(merged.messages.map((m) => messageText(m)).slice(-4)).toEqual(["own turn", "own answer", "from the terminal", "terminal answer"]);
    expect(merged.messages.slice(0, 7).map((m) => m.id)).toEqual(own.messages.map((m) => m.id));
    expect((await second.service.getSessionDetail("s1")).transcript.messages.map((m) => m.id)).toEqual(merged.messages.map((m) => m.id));
  });

  it("coalesces streaming writes and writes at once at message end", async () => {
    const store = openStore(tempDir());
    store.upsertWorkspace(workspace("w"));
    store.upsertSession(session("s", "w"));
    const save = vi.spyOn(store, "saveTranscriptChanges");
    const writer = new TranscriptWriter(store, "s", { messages: [], toolResults: {} }, 60);
    let t: Transcript = { messages: [assistant("m1", "", 1, { streaming: true })], toolResults: {} };
    writer.update(t);
    for (const chunk of ["Hel", "lo", " world"]) {
      const m = t.messages[0] as Extract<ChatMessage, { role: "assistant" }>;
      t = { ...t, messages: [{ ...m, content: [{ type: "text", text: messageText(m) + chunk }] }] };
      writer.update(t);
    }
    expect(save).not.toHaveBeenCalled();
    expect(store.hasTranscript("s")).toBe(false);
    await until(() => save.mock.calls.length === 1);
    expect(messageText(store.loadTranscript("s").messages[0]!)).toBe("Hello world");
    expect(store.db.prepare("SELECT status FROM messages WHERE id = 'm1'").get()).toEqual({ status: "streaming" });

    t = { ...t, messages: [assistant("m1", "Hello world!", 1, { streaming: false })] };
    writer.update(t, true); // message_end
    expect(save).toHaveBeenCalledTimes(2);
    expect(store.db.prepare("SELECT status, text FROM messages WHERE id = 'm1'").get()).toEqual({ status: "done", text: "Hello world!" });
    writer.update(t, true); // nothing changed: no write
    expect(save).toHaveBeenCalledTimes(2);

    t = { ...t, messages: [...t.messages, user("m2", "next", 2)] };
    writer.update(t);
    writer.close(); // shutdown flushes what's pending
    expect(save).toHaveBeenCalledTimes(3);
    expect(store.loadTranscript("s").messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("rewrites harness message ids to Glade ids (per process)", () => {
    const ids = new MessageIds();
    const start = ids.rewrite({ type: "message_start", message: assistant("m0", "", 1) });
    const id = (start as { message: ChatMessage }).message.id;
    expect(isUlid(id)).toBe(true);
    expect(ids.rewrite({ type: "block_delta", messageId: "m0", index: 0, delta: "x" })).toMatchObject({ messageId: id });
    expect(ids.rewrite({ type: "message_end", message: assistant("m0", "x", 1) })).toMatchObject({ message: { id } });
    const shell = { type: "message_end", message: { id: "shell-1", role: "shell" } } as unknown as AgentEvent;
    expect(ids.rewrite(shell)).toBe(shell);
  });

  it("shows a session running in another server from what that server writes (I-062)", async () => {
    const dir = tempDir();
    const dataDir = join(dir, "data");
    const harness = new FakeHarness();
    const servers = ["A", "B"].map((id) => {
      const store = new Store(dataDir, 0);
      const registry = new ServerRegistry(dataDir, { kind: id === "A" ? "desktop" : "dev", host: "127.0.0.1", port: 0, id });
      registry.start();
      const svc = new AppService({ store, harnesses: new HarnessRegistry([harness]), scratchDir: join(dir, "scratch"), dataDir, registry, leaseScanMs: 40 });
      cleanups.push(async () => {
        await svc.dispose();
        registry.release();
      });
      return { store, service: svc };
    });
    const [a, b] = servers as [(typeof servers)[0], (typeof servers)[0]];
    const created = await a.service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    const fake = [...harness.openSessions].find((s) => s.sessionRef === a.store.getSession(sid)!.sessionRef)!;
    fake.emit({ type: "run_start" });
    fake.emit({ type: "message_start", message: assistant("x", "", Date.now(), { streaming: true }) });
    fake.emit({ type: "block_start", messageId: "x", index: 0, block: { type: "text", text: "" } });
    fake.emit({ type: "block_delta", messageId: "x", index: 0, delta: "streaming in A" });
    await until(() => b.service.listSessions().find((s) => s.id === sid)?.activeElsewhere !== undefined, 4000);
    await until(() => b.store.loadTranscript(sid).messages.length === 1, 4000);
    const detail = await b.service.getSessionDetail(sid);
    expect(detail.offline).toBe(true);
    expect(detail.transcript.messages.map((m) => messageText(m))).toEqual(["streaming in A"]);
    expect(detail.transcript.messages[0]!.id).toBe((await a.service.getSessionDetail(sid)).transcript.messages[0]!.id);
  });
});

describe("mergeTranscripts", () => {
  it("keeps stored ids and order, inserts what's new where it belongs, matches shells and compactions by content", () => {
    const stored: Transcript = {
      messages: [
        user("g1", "hi", 1),
        assistant("g2", "partial", 2, { streaming: true }),
        { id: "g3", role: "shell", command: "ls", shared: true, running: false, output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 900 },
        { id: "g4", role: "notice", kind: "compaction", text: "Compacted context: 10k → 2k tokens", timestamp: 950 },
      ],
      toolResults: { t1: { toolCallId: "t1", toolName: "bash", status: "running", output: "" } },
    };
    const imported: Transcript = {
      messages: [
        user("f0", "hi", 1),
        assistant("f1", "partial and final", 2),
        user("f2", "added in a terminal", 3),
        { id: "f3", role: "shell", command: "ls", shared: true, running: false, output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 4 },
        { id: "f4", role: "notice", kind: "compaction", text: "Compacted context: 10k tokens", timestamp: 5 },
        assistant("f5", "after", 6),
      ],
      toolResults: { t1: { toolCallId: "t1", toolName: "bash", status: "done", output: "ok" }, t2: { toolCallId: "t2", toolName: "read", status: "done", output: "x" } },
    };
    let n = 0;
    const { transcript, added, updated } = mergeTranscripts(stored, imported, () => `new${n++}`);
    expect(transcript.messages.map((m) => m.id)).toEqual(["g1", "g2", "new0", "g3", "g4", "new1"]);
    expect(messageText(transcript.messages[1]!)).toBe("partial and final");
    expect({ added, updated }).toEqual({ added: 2, updated: 1 });
    expect(transcript.toolResults.t1?.status).toBe("done");
    expect(transcript.toolResults.t2).toBeDefined();
    // Merging the same again adds nothing.
    expect(mergeTranscripts(transcript, imported, () => "x").added).toBe(0);
  });
});
