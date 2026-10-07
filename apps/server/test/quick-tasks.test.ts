/**
 * I-198: per-agent model settings and the Glade-wide quick-tasks model. "alpha" stands in for pi
 * (one-shot `complete`, can run quick tasks), "beta" for Codex (no titles, no `complete`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ModelRef } from "@glade/protocol";
import { FAKE_MODELS, FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import type { CompletionRequest, GenerateTitleOptions } from "../src/harness/types.js";
import { createApp } from "../src/http/app.js";
import { configuredQuickTasks, quickCompletionRunner } from "../src/services/app/quick-tasks.js";
import { AppService } from "../src/services/app-service.js";
import { FolderInfoService } from "../src/services/folder-info.js";
import { smallModel, smallModelRef } from "../src/services/search/create.js";
import { Store } from "../src/store/store.js";
import { flush, until } from "./helpers.js";

const HAIKU: ModelInfo = { ...FAKE_MODELS[1]!, provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" };
const FAST: ModelRef = { provider: "fake", id: "fast" };
const SMART: ModelRef = { provider: "fake", id: "smart" };

let dir: string;
let store: Store;
let alpha: FakeHarness & { complete: ReturnType<typeof vi.fn<(r: CompletionRequest) => Promise<string | null>>> };
let beta: FakeHarness;
let enabled: Record<string, boolean>;
let registry: HarnessRegistry;
let service: AppService;
let alphaTitles: GenerateTitleOptions[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-quick-"));
  store = new Store(join(dir, "data"), 0);
  alphaTitles = [];
  alpha = Object.assign(new FakeHarness(undefined, 0, { id: "alpha", label: "Alpha" }), {
    complete: vi.fn(async (r: CompletionRequest) => (r.prompt.includes("title") ? "Quick title" : "done")),
  });
  alpha.generateTitle = async (options) => {
    alphaTitles.push(options);
    return "Alpha's own title";
  };
  // Like Codex: neither titles nor one-shot completions.
  beta = Object.assign(new FakeHarness(undefined, 0, { id: "beta", label: "Beta", capabilities: { quickTasks: false } }), { generateTitle: undefined });
  enabled = { alpha: true, beta: true };
  registry = new HarnessRegistry([alpha, beta], { enabled: (id) => enabled[id] ?? true });
  service = new AppService({ store, harnesses: registry, scratchDir: join(dir, "scratch") });
});

afterEach(async () => {
  await service.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const titleOf = (sid: string) => store.getSession(sid)!.title;

describe("new chats use their own agent's defaults", () => {
  it("never another agent's model or thinking level", async () => {
    service.updateSettings({ models: { agents: { alpha: { defaultModel: FAST, defaultThinkingLevel: "high" } } } });
    const a = await service.createWorkspace({ projectId: null, harness: "alpha" });
    const b = await service.createWorkspace({ projectId: null, harness: "beta" });
    expect(a.session.session).toMatchObject({ harness: "alpha", model: FAST, thinkingLevel: "high" });
    // beta has no settings: its own default model (the fake reports "smart") and the default thinking level.
    expect(b.session.session).toMatchObject({ harness: "beta", model: SMART, thinkingLevel: "medium" });

    service.updateSettings({ models: { agents: { beta: { defaultModel: SMART, defaultThinkingLevel: "low" } } } });
    const b2 = await service.createWorkspace({ projectId: null, harness: "beta" });
    expect(b2.session.session).toMatchObject({ model: SMART, thinkingLevel: "low" });
    // The request still wins.
    const b3 = await service.createWorkspace({ projectId: null, harness: "beta", model: FAST, thinkingLevel: "off" });
    expect(b3.session.session).toMatchObject({ model: FAST, thinkingLevel: "off" });
  });

  it("sub-agents read the parent's agent's settings", async () => {
    service.setServerUrl("http://127.0.0.1:4999");
    beta.script = () => [];
    service.updateSettings({ models: { agents: { alpha: { subagentModel: FAST, subagentThinkingLevel: "off" } } } });
    const chat = await service.createWorkspace({ projectId: null, harness: "beta", prompt: "go", model: SMART, thinkingLevel: "high" });
    await flush();
    const { agent } = await service.spawnAgent(chat.session.session.id, { name: "helper", task: "do it" });
    expect(store.getSession(agent.sessionId)).toMatchObject({ harness: "beta", model: SMART, thinkingLevel: "high" });
  });
});

describe("quick-tasks model", () => {
  it("titles a chat of an agent without titles with the quick-tasks agent and model, in the chat's folder", async () => {
    service.updateSettings({ models: { quickTasks: { harness: "alpha", model: FAST } } });
    const chat = await service.createWorkspace({ projectId: null, harness: "beta", prompt: "fix the login form" });
    const sid = chat.session.session.id;
    await until(() => titleOf(sid) === "Quick title");
    const call = alpha.complete.mock.calls.at(-1)![0];
    expect(call.model).toEqual(FAST);
    expect(call.prompt).toContain("fix the login form");
    expect(call.cwd).toBe(store.getWorkspace(chat.workspace.id)!.cwd);
    expect(alphaTitles).toEqual([]); // the chosen model goes through `complete`, not the agent's own titles

    // `/name` too.
    await until(() => !service.listSessions().find((s) => s.id === sid)!.running);
    const res = await service.generateSessionTitle(sid);
    expect(res.title).toBe("Quick title");
  });

  it("titles every agent's chats with it (here alpha's own)", async () => {
    service.updateSettings({ models: { quickTasks: { harness: "alpha", model: FAST } } });
    const chat = await service.createWorkspace({ projectId: null, harness: "alpha", prompt: "hello" });
    await until(() => titleOf(chat.session.session.id) === "Quick title");
    expect(alpha.complete.mock.calls.at(-1)![0].model).toEqual(FAST);
  });

  it("falls back when unset or when its agent is turned off, unknown or can't run quick tasks", async () => {
    // Unset: beta can't title its chats (as before I-198); /name says so.
    const chat = await service.createWorkspace({ projectId: null, harness: "beta", prompt: "hello there" });
    const sid = chat.session.session.id;
    await until(() => !service.listSessions().find((s) => s.id === sid)!.running);
    await flush(5);
    expect(titleOf(sid)).toBe("hello there");
    await expect(service.generateSessionTitle(sid)).rejects.toMatchObject({ status: 501 });

    service.updateSettings({ models: { quickTasks: { harness: "alpha", model: FAST } } });
    enabled.alpha = false;
    await expect(service.generateSessionTitle(sid)).rejects.toMatchObject({ status: 501 });
    enabled.alpha = true;

    const settings = () => store.getSettings();
    expect(configuredQuickTasks(settings(), registry, "title")?.harness).toBe(alpha);
    service.updateSettings({ models: { quickTasks: { harness: "gone", model: FAST } } });
    expect(store.getSettings().models.quickTasks).toEqual({ harness: "gone", model: FAST }); // kept
    expect(configuredQuickTasks(settings(), registry, "title")).toBeNull();
    service.updateSettings({ models: { quickTasks: { harness: "beta", model: FAST } } });
    expect(configuredQuickTasks(settings(), registry, "title")).toBeNull();

    // An alpha chat falls back to its own titles, with Haiku when it lists it.
    alpha.listModels = async () => [...FAKE_MODELS, HAIKU];
    const own = await service.createWorkspace({ projectId: null, harness: "alpha", prompt: "hello" });
    await until(() => titleOf(own.session.session.id) === "Alpha's own title");
    expect(alphaTitles.at(-1)!.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("runs summaries, search and commit messages with it, else the default agent with Haiku when listed", async () => {
    registry = new HarnessRegistry([beta, alpha], { preferred: () => "beta", enabled: (id) => enabled[id] ?? true });
    const settings = () => store.getSettings();
    // Nothing set, default agent beta can't complete.
    expect(await quickCompletionRunner(settings(), registry)).toBeNull();
    expect(await smallModel(registry, settings)!({ prompt: "p", model: null })).toBeNull();

    store.updateSettings({ models: { quickTasks: { harness: "alpha", model: FAST } } });
    expect(await smallModelRef(registry, settings)()).toEqual(FAST);
    expect(await smallModel(registry, settings)!({ prompt: "summarize", model: FAST })).toBe("done");
    expect(alpha.complete).toHaveBeenLastCalledWith({ prompt: "summarize", model: FAST, timeoutMs: undefined });

    // AppService's commit messages (default agent alpha in `service`).
    store.updateSettings({ models: { quickTasks: null } });
    alpha.listModels = async () => [...FAKE_MODELS, HAIKU];
    await service.completeQuick("commit message please", "/tmp/x");
    expect(alpha.complete.mock.calls.at(-1)![0]).toMatchObject({ model: { provider: "anthropic", id: "claude-haiku-4-5" }, cwd: "/tmp/x" });
    store.updateSettings({ models: { quickTasks: { harness: "alpha", model: SMART } } });
    await service.completeQuick("commit message please", "/tmp/x");
    expect(alpha.complete.mock.calls.at(-1)![0]).toMatchObject({ model: SMART });
  });

  it("the settings route validates quickTasks loosely", () => {
    expect(() => service.updateSettings({ models: { quickTasks: { harness: "", model: FAST } } })).toThrow(/quickTasks/);
    expect(() => service.updateSettings({ models: { quickTasks: { harness: "alpha" } } } as never)).toThrow(/quickTasks/);
    expect(() => service.updateSettings({ models: { agents: { alpha: { hiddenModels: "x" } } } } as never)).toThrow(/hiddenModels/);
    service.updateSettings({ models: { quickTasks: { harness: "alpha", model: FAST } } });
    service.updateSettings({ models: { quickTasks: null } });
    expect(service.getSettings().models.quickTasks).toBeNull();
  });
});

describe("capabilities", () => {
  it("only agents that can run quick tasks say so", () => {
    expect(registry.info().map((h) => [h.id, !!h.capabilities.quickTasks])).toEqual([
      ["alpha", true],
      ["beta", false],
    ]);
  });
});

describe("GET /api/models/default?harness=", () => {
  it("answers with that agent's own defaults; 404 for one that isn't offered", async () => {
    vi.spyOn(beta, "getDefaults").mockResolvedValue({ model: FAST, thinkingLevel: "low" });
    const folderInfo = new FolderInfoService({
      harness: (id) => {
        if (!id) return registry.default();
        const h = registry.get(id);
        return h && registry.isOffered(h) ? h : undefined;
      },
      scratchDir: join(dir, "scratch"),
      projectPath: () => undefined,
    });
    const { app } = createApp({ service, folderInfo });
    const get = (path: string) => app.request(path, { headers: { host: "127.0.0.1:4317" } });
    expect(await (await get("/api/models/default")).json()).toEqual({ model: SMART, thinkingLevel: null });
    expect(await (await get("/api/models/default?harness=beta")).json()).toEqual({ model: FAST, thinkingLevel: "low" });
    expect((await get("/api/models/default?harness=nope")).status).toBe(404);
    enabled.beta = false;
    expect((await get("/api/models/default?harness=beta&refresh=1")).status).toBe(404);
  });
});
