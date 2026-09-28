/**
 * I-064: several harnesses per server. Sessions are routed by `Session.harness`; new chats use
 * the default harness (the `agent.defaultHarness` setting, else the first registered).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { smallModel } from "../src/services/search/create.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { flush, until } from "./helpers.js";

describe("HarnessRegistry", () => {
  it("defaults to the preferred harness when registered, else the first one", () => {
    let preferred: string | null = null;
    const a = new FakeHarness(undefined, 0, { id: "alpha" });
    const b = new FakeHarness(undefined, 0, { id: "beta", label: "Beta", capabilities: { compact: false } });
    const registry = new HarnessRegistry([a, b], { preferred: () => preferred });
    expect(registry.default()).toBe(a);
    preferred = "beta";
    expect(registry.default()).toBe(b);
    preferred = "missing";
    expect(registry.default()).toBe(a);
    expect(registry.get("beta")).toBe(b);
    expect(registry.get("nope")).toBeUndefined();
    expect(() => registry.register(new FakeHarness(undefined, 0, { id: "alpha" }))).toThrow(/already registered/);
  });

  it("describes harnesses with the default first", () => {
    const a = new FakeHarness(undefined, 0, { id: "alpha" });
    const b = new FakeHarness(undefined, 0, { id: "beta", label: "Beta", capabilities: { compact: false } });
    const info = new HarnessRegistry([a, b], { preferred: () => "beta" }).info();
    expect(info.map((h) => [h.id, h.label, h.isDefault, h.capabilities.compact])).toEqual([
      ["beta", "Beta", true, false],
      ["alpha", "Fake agent", false, true],
    ]);
  });

  it("throws when nothing is registered", () => {
    expect(() => new HarnessRegistry().default()).toThrow(/No harness/);
  });
});

describe("AppService with two harnesses", () => {
  let dir: string;
  let alpha: FakeHarness;
  let beta: FakeHarness;
  let services: AppService[];

  function start(harnesses: FakeHarness[] = [alpha, beta]): { service: AppService; store: Store } {
    const store = new Store(join(dir, "data"), 0);
    const registry = new HarnessRegistry(harnesses, { preferred: () => store.getSettings().agent.defaultHarness });
    const service = new AppService({ store, harnesses: registry, scratchDir: join(dir, "scratch") });
    services.push(service);
    return { service, store };
  }

  /** A restart without disposing the harnesses (their in-memory sessions survive). */
  async function restart(harnesses?: FakeHarness[]) {
    const old = services.pop()!;
    for (const h of [alpha, beta]) vi.spyOn(h, "dispose").mockResolvedValueOnce();
    await old.dispose();
    return start(harnesses);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-harnesses-"));
    alpha = new FakeHarness(undefined, 0, { id: "alpha" });
    beta = new FakeHarness(undefined, 0, { id: "beta" });
    services = [];
  });
  afterEach(async () => {
    for (const s of services) await s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stamps new chats with the default harness and follows the setting", async () => {
    const { service } = start();
    const first = await service.createWorkspace({ projectId: null });
    expect(first.session.session.harness).toBe("alpha");
    expect(alpha.openSessions.size).toBe(1);
    service.updateSettings({ agent: { defaultHarness: "beta" } });
    const second = await service.createWorkspace({ projectId: null });
    expect(second.session.session.harness).toBe("beta");
    expect(beta.openSessions.size).toBe(1);
    expect(service.listHarnesses().map((h) => [h.id, h.isDefault])).toEqual([
      ["beta", true],
      ["alpha", false],
    ]);
  });

  it("reopens and deletes each session through its own harness", async () => {
    let { service } = start();
    const a = await service.createWorkspace({ projectId: null, prompt: "hello alpha" });
    service.updateSettings({ agent: { defaultHarness: "beta" } });
    const b = await service.createWorkspace({ projectId: null, prompt: "hello beta" });
    await flush();
    const aRef = service.listSessions().find((s) => s.id === a.session.session.id)!.sessionRef!;
    const bRef = service.listSessions().find((s) => s.id === b.session.session.id)!.sessionRef!;
    expect(alpha.sessions.has(aRef)).toBe(true);
    expect(beta.sessions.has(bRef)).toBe(true);

    ({ service } = await restart());
    const aOpen = vi.spyOn(alpha, "openSession");
    const bOpen = vi.spyOn(beta, "openSession");
    const detail = await service.getSessionDetail(a.session.session.id);
    expect(aOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionRef: aRef }));
    expect(bOpen).not.toHaveBeenCalled();
    expect(detail.transcript.messages.some((m) => m.role === "user")).toBe(true);
    await service.getSessionDetail(b.session.session.id);
    expect(bOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionRef: bRef }));

    await service.deleteWorkspace(a.workspace.id);
    expect(alpha.sessions.has(aRef)).toBe(false);
    expect(beta.sessions.has(bRef)).toBe(true);
  });

  it("uses the session's harness for its slash commands and titles", async () => {
    const { service } = start();
    service.updateSettings({ agent: { defaultHarness: "beta" } });
    const title = vi.fn(async () => "Beta title");
    beta.generateTitle = title;
    alpha.generateTitle = vi.fn(async () => "Alpha title");
    const b = await service.createWorkspace({ projectId: null, prompt: "hello" });
    await until(() => title.mock.calls.length === 1);
    expect(alpha.generateTitle).not.toHaveBeenCalled();
    const cmds = vi.spyOn(beta.openSessions.values().next().value!, "listCommands");
    await service.listCommands(b.session.session.id);
    expect(cmds).toHaveBeenCalled();
  });

  it("gives a clear error for a chat whose harness isn't installed", async () => {
    let { service } = start();
    service.updateSettings({ agent: { defaultHarness: "beta" } });
    const b = await service.createWorkspace({ projectId: null });
    service.updateSettings({ agent: { defaultHarness: null } });
    ({ service } = await restart([alpha]));
    await expect(service.getSessionDetail(b.session.session.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('"beta" agent'),
    });
    // Other chats still work, and new ones fall back to an installed harness.
    const a = await service.createWorkspace({ projectId: null });
    expect(a.session.session.harness).toBe("alpha");
  });
});

describe("search wiring (I-067)", () => {
  it("takes the small model from the registry", async () => {
    const reader = Object.assign(new FakeHarness(undefined, 0, { id: "reader" }), {
      complete: vi.fn(async () => "done"),
    });
    const plain = new FakeHarness(undefined, 0, { id: "plain" });
    const registry = new HarnessRegistry([plain, reader], { preferred: () => "reader" });
    expect(await smallModel(registry)!({ prompt: "p", model: null })).toBe("done");
    expect(smallModel(new HarnessRegistry([plain]))).toBeUndefined();
  });
});
