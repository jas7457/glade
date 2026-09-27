import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type AskResponse, type ModelInfo, type SearchResponse, type Project, type SessionSummary, type Settings, type WorkspaceSummary } from "@glade/protocol";
import { searchRoutes } from "../src/http/search.js";
import { SearchService, type SearchAppSource } from "../src/services/search/search-service.js";
import type { FastModel, SessionText, SessionTextReader } from "../src/services/search/types.js";

function session(id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: `w-${id}`,
    kind: "main",
    parentSessionId: null,
    agentName: null,
    title,
    titleSource: "auto",
    harness: "mem",
    sessionRef: `ref-${id}`,
    unread: false,
    createdAt: 1000,
    lastActivityAt: 5000,
    model: null,
    thinkingLevel: null,
    running: false,
    pendingInputs: 0,
    status: "idle",
    ...extra,
  };
}

function workspaceOf(s: SessionSummary, projectId: string | null = null): WorkspaceSummary {
  return {
    id: s.workspaceId,
    projectId,
    title: s.title,
    titleSource: "auto",
    cwd: "/tmp",
    pinned: false,
    createdAt: 1000,
    lastActivityAt: s.lastActivityAt,
    layout: null,
    status: "idle",
    running: false,
    pendingInputs: 0,
    unread: false,
    lastRunFailed: false,
    interrupted: false,
  };
}

/** In-memory "harness": sessionRef -> text + a version bumped on writes. */
class MemReader implements SessionTextReader {
  files = new Map<string, { text: SessionText; version: number }>();
  reads = 0;
  write(ref: string, messages: Array<[role: "user" | "assistant", text: string]>) {
    const version = (this.files.get(ref)?.version ?? 0) + 1;
    this.files.set(ref, { version, text: { name: null, messages: messages.map(([role, text]) => ({ role, text, timestamp: 0 })) } });
  }
  async stat(ref: string) {
    const f = this.files.get(ref);
    return f ? { mtimeMs: f.version, size: 1 } : null;
  }
  async read(ref: string) {
    this.reads++;
    return this.files.get(ref)?.text ?? null;
  }
}

let dir: string;
let reader: MemReader;
let sessions: SessionSummary[];
let settings: Settings;
let project: Project;
let clock: number;
const models: ModelInfo[] = [];
const app: SearchAppSource = {
  listSessions: () => sessions,
  listWorkspaces: () => sessions.map((s) => workspaceOf(s, s.id === "b" ? project.id : null)),
  listProjects: () => [project],
  getSettings: () => settings,
  listModels: async () => models,
};
const services: SearchService[] = [];
const make = (fastModel?: FastModel) => {
  const s = new SearchService({ app, dataDir: dir, readers: { mem: reader }, fastModel, pollMs: 0, debounceMs: 0, now: () => clock });
  services.push(s);
  return s;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-search-"));
  reader = new MemReader();
  settings = defaultSettings();
  clock = 1000;
  project = { id: "p1", name: "shop", path: "/tmp/shop", sortOrder: 0, createdAt: 0, lastActivityAt: 0 };
  sessions = [session("a", "Casual greeting"), session("b", "Checkout flow"), session("c", "Database work")];
  reader.write("ref-a", [
    ["user", "hey"],
    ["assistant", "Hi! Want to add the floating action button to the toolbar?"],
  ]);
  reader.write("ref-b", [
    ["user", "The checkout page crashes on submit"],
    ["assistant", "Fixed the null coupon in submitOrder."],
  ]);
  reader.write("ref-c", [
    ["user", "Write a migration adding an index on users.email"],
    ["assistant", "Done."],
  ]);
});
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("SearchService.search", () => {
  it("finds text inside conversations with project and snippet", async () => {
    const res = await make().search("null coupon");
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ sessionId: "b", workspaceId: "w-b", project: "shop", projectId: "p1", matchedIn: "assistant" });
    expect(res.hits[0]!.snippet.text).toContain("null coupon");
  });

  it("re-reads only changed files and picks up new messages and titles", async () => {
    const search = make();
    await search.search("x");
    expect(reader.reads).toBe(3);
    reader.write("ref-c", [
      ["user", "Write a migration adding an index on users.email"],
      ["assistant", "Done. Also added a rollback script."],
    ]);
    clock += 5000;
    expect((await search.search("rollback")).hits.map((h) => h.sessionId)).toEqual(["c"]);
    expect(reader.reads).toBe(4);
    sessions = sessions.map((s) => (s.id === "a" ? { ...s, title: "Toolbar ideas" } : s));
    clock += 5000;
    expect((await search.search("ideas")).hits[0]).toMatchObject({ sessionId: "a", matchedIn: "title" });
  });

  it("persists extracted text so a restart doesn't re-read unchanged files", async () => {
    await make().search("x");
    services[0]!.dispose();
    const cache = JSON.parse(readFileSync(join(dir, "search-index.json"), "utf8"));
    expect(Object.keys(cache.sessions).sort()).toEqual(["a", "b", "c"]);
    const second = make();
    expect((await second.search("coupon")).hits).toHaveLength(1);
    expect(reader.reads).toBe(3);
  });

  it("forgets deleted sessions", async () => {
    const search = make();
    expect((await search.search("coupon")).hits).toHaveLength(1);
    sessions = sessions.filter((s) => s.id !== "b");
    clock += 5000;
    expect((await search.search("coupon")).hits).toHaveLength(0);
  });
});

describe("SearchService summaries", () => {
  it("summarizes settled sessions active since enabling, once per change", async () => {
    const fast = vi.fn<FastModel>(async ({ prompt }) => (prompt.includes("checkout") ? "Fixing a checkout crash." : "Other."));
    sessions = sessions.map((s) => (s.id === "c" ? { ...s, lastActivityAt: 10 } : s.id === "a" ? { ...s, running: true } : s));
    const search = make(fast);
    await search.refresh();
    await search.idle();
    expect(fast).toHaveBeenCalledTimes(1); // a is running, c is older than enabledAt
    expect(search.summaryOf("b")).toBe("Fixing a checkout crash.");
    clock += 5000;
    await search.refresh();
    await search.idle();
    expect(fast).toHaveBeenCalledTimes(1);
    // Summaries are searchable.
    expect((await search.search("crash")).hits[0]).toMatchObject({ sessionId: "b" });
  });

  it("can be turned off", async () => {
    const fast = vi.fn<FastModel>(async () => "x");
    settings = { ...settings, general: { ...settings.general, generateSummaries: false } };
    const search = make(fast);
    await search.refresh();
    await search.idle();
    expect(fast).not.toHaveBeenCalled();
  });
});

describe("SearchService.ask", () => {
  it("lets the fast model pick among keyword + recent candidates", async () => {
    settings = { ...settings, general: { ...settings.general, generateSummaries: false } };
    const fast = vi.fn<FastModel>(async ({ prompt }) => {
      const label = /(c\d+): "Casual greeting"/.exec(prompt)![1];
      return `{"matches":[{"id":"${label}","reason":"talked about the toolbar button"}],"confident":true}`;
    });
    const res = await make(fast).ask("that chat about the floating thing in the toolbar");
    expect(res).toMatchObject({ confident: true, matches: [{ sessionId: "a", reason: "talked about the toolbar button" }] });
    // Every session is a candidate (keyword hits + recent padding).
    expect(fast.mock.calls[0]![0].prompt).toContain('"Database work"');
    expect(fast.mock.calls[0]![0].model).toBeNull(); // no title model, Haiku not listed
  });

  it("uses the title model setting, else Haiku when available", async () => {
    settings = { ...settings, general: { ...settings.general, generateSummaries: false } };
    const fast = vi.fn<FastModel>(async () => '{"matches":[]}');
    models.push({ provider: "anthropic", id: "claude-haiku-4-5" } as ModelInfo);
    try {
      const res = await make(fast).ask("anything");
      expect(fast.mock.calls[0]![0].model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
      expect(res).toMatchObject({ matches: [], confident: false, model: "anthropic/claude-haiku-4-5" });
    } finally {
      models.length = 0;
    }
  });

  it("falls back to keyword ranking without a model or on a bad reply", async () => {
    expect(await make().ask("checkout crash")).toMatchObject({ model: null, confident: false, matches: [{ sessionId: "b", reason: "" }] });
    const res = await make(async () => "I don't know").ask("migration users");
    expect(res.matches.map((m) => m.sessionId)).toEqual(["c"]);
  });
});

describe("search routes", () => {
  it("serves GET /search and POST /search/ask", async () => {
    const routes = searchRoutes(make());
    const res = await routes.request("/search?q=coupon&limit=5");
    expect(res.status).toBe(200);
    expect(((await res.json()) as SearchResponse).hits[0]!.sessionId).toBe("b");
    const ask = await routes.request("/search/ask", { method: "POST", body: JSON.stringify({ query: "checkout" }), headers: { "content-type": "application/json" } });
    expect(((await ask.json()) as AskResponse).matches[0]!.sessionId).toBe("b");
    const bad = await routes.request("/search/ask", { method: "POST", body: JSON.stringify({ query: " " }) });
    expect(bad.status).toBe(400);
  });
});
