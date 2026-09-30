/**
 * The new-chat composer asks the agent it has picked (I-184, I-185): folder commands and the
 * permission modes a new chat can start in, per harness; and a chat created with a mode starts in it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderPermissionModes, PermissionModeInfo, SlashCommand } from "@glade/protocol";
import { FAKE_COMMANDS, FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import { FolderInfoService } from "../src/services/folder-info.js";
import { Store } from "../src/store/store.js";

const MODES: PermissionModeInfo[] = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "yolo", label: "Yolo", danger: true },
];
const MODED_COMMANDS: SlashCommand[] = [{ name: "review", description: "Review", source: "extension" }];

let dir: string;
let store: Store;
let plain: FakeHarness;
let moded: FakeHarness;
let service: AppService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-newchat-"));
  store = new Store(join(dir, "data"), 0);
  plain = new FakeHarness(undefined, 0, { id: "plain", label: "Plain" });
  moded = new FakeHarness(undefined, 0, { id: "moded", label: "Moded", permissionModes: MODES, defaultPermissionMode: "ask" });
  vi.spyOn(moded, "listFolderCommands").mockResolvedValue(MODED_COMMANDS);
  service = new AppService({ store, harnesses: new HarnessRegistry([plain, moded]), scratchDir: join(dir, "scratch") });
});

afterEach(async () => {
  await service.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function routes() {
  const registry = new HarnessRegistry([plain, moded]);
  const folderInfo = new FolderInfoService({
    harness: (id) => (id ? registry.get(id) : registry.default()),
    scratchDir: join(dir, "scratch"),
    projectPath: (id) => store.getProject(id)?.path,
  });
  const { app } = createApp({ service, folderInfo });
  const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await app.request(path, { headers: { host: "127.0.0.1:4317" } });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { folderInfo, get };
}

describe("folder info for the picked agent", () => {
  it("lists the picked agent's folder commands, the default agent's without one, cached per agent", async () => {
    const { get, folderInfo } = routes();
    expect((await get<SlashCommand[]>("/api/commands")).body).toEqual(FAKE_COMMANDS);
    expect((await get<SlashCommand[]>("/api/commands?harness=moded")).body).toEqual(MODED_COMMANDS);
    expect((await get<SlashCommand[]>("/api/commands?harness=plain")).body).toEqual(FAKE_COMMANDS);
    await folderInfo.listCommands(null, false, "moded");
    expect(moded.listFolderCommands).toHaveBeenCalledTimes(1);
    expect((await get<{ error: string }>("/api/commands?harness=nope")).status).toBe(400);
  });

  it("serves the modes a new chat can start in, none for agents without modes", async () => {
    const projectDir = join(dir, "proj");
    mkdirSync(projectDir);
    const project = service.createProject({ path: projectDir });
    const { get } = routes();
    expect((await get<FolderPermissionModes>(`/api/permission-modes?projectId=${project.id}&harness=moded&provider=fake&model=m1`)).body).toEqual({
      modes: MODES,
      defaultMode: "ask",
    });
    expect(moded.permissionModeQueries).toEqual([{ cwd: projectDir, model: { provider: "fake", id: "m1" } }]);
    // Cached per folder + model.
    await get(`/api/permission-modes?projectId=${project.id}&harness=moded&provider=fake&model=m1`);
    expect(moded.permissionModeQueries).toHaveLength(1);
    await get("/api/permission-modes?harness=moded");
    expect(moded.permissionModeQueries.at(-1)).toEqual({ cwd: join(dir, "scratch"), model: null });
    // No modes: the plain fake, and the default agent (plain) without `harness`.
    expect((await get<FolderPermissionModes>("/api/permission-modes?harness=plain")).body).toEqual({ modes: [], defaultMode: null });
    expect((await get<FolderPermissionModes>("/api/permission-modes")).body).toEqual({ modes: [], defaultMode: null });
    expect(plain.permissionModeQueries).toEqual([]);
    expect((await get("/api/permission-modes?harness=nope")).status).toBe(400);
    expect((await get("/api/permission-modes?projectId=nope&harness=moded")).status).toBe(404);
  });
});

describe("starting a chat in a mode", () => {
  it("starts the new chat in the picked mode and saves it", async () => {
    const created = await service.createWorkspace({ projectId: null, harness: "moded", permissionMode: "plan" });
    expect(created.session.state.permissionMode).toBe("plan");
    expect(created.session.state.permissionModes).toEqual(MODES);
    expect(store.getSession(created.session.session.id)!.permissionMode).toBe("plan");
  });

  it("uses the agent's own default without one, and never carries a mode over", async () => {
    const first = await service.createWorkspace({ projectId: null, harness: "moded", permissionMode: "yolo" });
    const second = await service.createWorkspace({ projectId: null, harness: "moded" });
    expect(second.session.state.permissionMode).toBe("ask");
    expect(store.getSession(second.session.session.id)!.permissionMode ?? null).not.toBe("yolo");
    // A new tab in the same chat starts in the default too.
    const tab = await service.createSession(first.workspace.id, { harness: "moded" });
    expect(tab.state.permissionMode).toBe("ask");
  });

  it("falls back to the default for an unknown mode and ignores modes for agents without them", async () => {
    const unknown = await service.createWorkspace({ projectId: null, harness: "moded", permissionMode: "bogus" });
    expect(unknown.session.state.permissionMode).toBe("ask");
    const none = await service.createWorkspace({ projectId: null, harness: "plain", permissionMode: "plan" });
    expect(none.session.state.permissionMode ?? null).toBeNull();
    expect(store.getSession(none.session.session.id)!.permissionMode).toBeUndefined();
  });

  it("accepts the mode over HTTP and rejects a non-string", async () => {
    const { app } = createApp({ service });
    const post = (body: unknown) =>
      app.request("/api/workspaces", { method: "POST", headers: { host: "127.0.0.1:4317", "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ projectId: null, harness: "moded", permissionMode: "plan" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { session: { state: { permissionMode: string } } }).session.state.permissionMode).toBe("plan");
    expect((await post({ projectId: null, harness: "moded", permissionMode: 3 })).status).toBe(400);
  });
});
