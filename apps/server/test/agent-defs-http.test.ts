/**
 * I-218: the agent-defs REST routes (list, save, delete, describe, tools), the `agentDefs` settings
 * patch, dropping a deleted project's switches, and paired devices being read-only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAgentDefFields, type AgentDefToolsResponse, type ListAgentDefsResponse, type PairingInvite, type PairResponse, type Project, type SaveAgentDefResponse } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AgentDefsService } from "../src/services/agent-defs/service.js";
import { AppService } from "../src/services/app-service.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import { Store } from "../src/store/store.js";

let dir: string;
let store: Store;
let service: AppService;
let auth: AuthService;
let app: ReturnType<typeof createApp>["app"];
let home: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-agent-defs-http-"));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  store = new Store(join(dir, "data"), 0);
  // The fake harness has id "fake"; agents on it are offered.
  const agentDefs = new AgentDefsService({ dataDir: join(dir, "data"), homeDir: home, env: {} });
  service = new AppService({ store, harnesses: new HarnessRegistry([new FakeHarness()]), scratchDir: join(dir, "scratch"), agentDefs, sync: { batchMs: 10_000 } });
  auth = new AuthService({
    db: store.db,
    environmentId: service.environment.id,
    environmentName: () => "Air",
    addresses: () => ["http://127.0.0.1:4317"],
    watchMs: 0,
    pairTimeoutMs: 5000,
    pairPollMs: 5,
    tailscaleLogin: async () => null,
  });
  app = createApp({ service, auth, ownPorts: () => [4317, 5317] }).app;
});
afterEach(async () => {
  auth.dispose();
  await service.dispose();
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, o: { body?: unknown; token?: string; remote?: boolean } = {}) {
  return app.request(
    path,
    {
      method,
      headers: {
        host: "127.0.0.1:4317",
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.remote ? { origin: "http://127.0.0.1:4400" } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
}

const fields = (over: Partial<ReturnType<typeof emptyAgentDefFields>>) => ({ ...emptyAgentDefFields(), ...over });

async function project(body: { path?: string; name?: string }): Promise<Project> {
  const res = await call("POST", "/api/projects", { body });
  expect(res.status).toBe(200);
  return (await res.json()) as Project;
}

describe("agent-defs REST", () => {
  it("saves, lists, renames and deletes personal and project agents", async () => {
    const p = await project({ path: repo });
    const saved = await call("PUT", "/api/agent-defs", { body: { scope: "personal", fields: fields({ name: "scout", harness: "fake", prompt: "Look." }) } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SaveAgentDefResponse).agent).toMatchObject({ id: "personal:scout", available: true, enabled: true });
    expect((await call("PUT", "/api/agent-defs", { body: { scope: "project", projectId: p.id, fields: fields({ name: "ranger", harness: "fake" }) } })).status).toBe(200);

    const listed = (await (await call("GET", `/api/agent-defs?projectId=${p.id}`)).json()) as ListAgentDefsResponse;
    expect(listed.agents.map((a) => a.id)).toEqual(["project:ranger", "personal:scout"]);
    const global = (await (await call("GET", "/api/agent-defs")).json()) as ListAgentDefsResponse;
    expect(global.agents.map((a) => a.id)).toEqual(["personal:scout"]);

    const renamed = await call("PUT", "/api/agent-defs", { body: { scope: "personal", previousName: "scout", fields: fields({ name: "finder", harness: "fake" }) } });
    expect(((await renamed.json()) as SaveAgentDefResponse).agent.id).toBe("personal:finder");
    expect((await call("DELETE", "/api/agent-defs?scope=personal&name=finder")).status).toBe(204);
    expect((await call("DELETE", "/api/agent-defs?scope=personal&name=finder")).status).toBe(404);
    expect((await call("DELETE", `/api/agent-defs?scope=project&name=ranger&projectId=${p.id}`)).status).toBe(204);
    expect(((await (await call("GET", `/api/agent-defs?projectId=${p.id}`)).json()) as ListAgentDefsResponse).agents).toEqual([]);
  });

  it("answers 400/404 for bad requests and group projects", async () => {
    const group = await project({ name: "Group" });
    const errorOf = async (res: Response | Promise<Response>) => {
      const r = await res;
      return { status: r.status, error: ((await r.json()) as { error: string }).error };
    };
    expect(await errorOf(call("PUT", "/api/agent-defs", { body: { scope: "project", projectId: group.id, fields: fields({ name: "x" }) } }))).toEqual({
      status: 400,
      error: "Group projects have no folder for project agents",
    });
    expect((await call("PUT", "/api/agent-defs", { body: { scope: "project", fields: fields({ name: "x" }) } })).status).toBe(400);
    expect((await call("PUT", "/api/agent-defs", { body: { scope: "elsewhere", fields: fields({ name: "x" }) } })).status).toBe(400);
    expect((await call("PUT", "/api/agent-defs", { body: { scope: "personal", fields: fields({ name: "x", model: "fake/smart" }) } })).status).toBe(400);
    expect((await call("PUT", "/api/agent-defs", { body: "nope" })).status).toBe(400);
    expect((await call("GET", "/api/agent-defs?projectId=missing")).status).toBe(404);
    expect((await call("DELETE", "/api/agent-defs?scope=personal")).status).toBe(400);
    expect((await call("GET", "/api/agent-defs/tools")).status).toBe(400);
    // A group project lists personal and discovered agents only.
    expect((await call("GET", `/api/agent-defs?projectId=${group.id}`)).status).toBe(200);
  });

  it("drafts a description with the quick-tasks model", async () => {
    // The fake harness can't do one-shot completions: 501.
    expect((await call("POST", "/api/agent-defs/describe", { body: { name: "scout", harness: "fake", prompt: "Find code." } })).status).toBe(501);
    const spy = vi.spyOn(service, "completeQuickAnywhere").mockResolvedValue('"Use when you need to find code, not for edits."\n');
    const res = await call("POST", "/api/agent-defs/describe", { body: { name: "scout", harness: "claude", prompt: "Find code." } });
    expect(await res.json()).toEqual({ description: "Use when you need to find code, not for edits." });
    expect(spy.mock.calls[0]![0]).toContain('sub-agent named "scout". It runs on Claude Code.');
    expect(spy.mock.calls[0]![0]).toContain("Find code.");
    expect((await call("POST", "/api/agent-defs/describe", { body: { name: "scout", harness: "claude", prompt: " " } })).status).toBe(400);
  });

  it("serves the tools last seen", async () => {
    const p = await project({ path: repo });
    service.agentDefs.recordTools("pi", p.id, ["read", "bash"], []);
    const res = (await (await call("GET", `/api/agent-defs/tools?harness=pi&projectId=${p.id}`)).json()) as AgentDefToolsResponse;
    expect(res).toMatchObject({ harness: "pi", tools: ["read", "bash"], mcpServers: [] });
    expect(((await (await call("GET", "/api/agent-defs/tools?harness=codex")).json()) as AgentDefToolsResponse).seenAt).toBeNull();
  });

  it("lists discovered agents of the home folder and the project", async () => {
    const p = await project({ path: repo });
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    writeFileSync(join(repo, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews\n---\nReview.");
    const listed = (await (await call("GET", `/api/agent-defs?projectId=${p.id}`)).json()) as ListAgentDefsResponse;
    // Claude Code isn't offered in this server (only the fake harness).
    // I-221: notes only go on agents that can run; this one's errors already say why not.
    expect(listed.agents).toEqual([expect.objectContaining({ id: "claude:reviewer", available: false, problems: ["Claude Code is turned off or not installed"] })]);
  });

  it("notes agents that pin a harness or a model while the sub-agent switches are off; they stay available (I-221)", async () => {
    const p = await project({ path: repo });
    mkdirSync(join(repo, ".agents", "agents"), { recursive: true });
    writeFileSync(join(repo, ".agents", "agents", "fastlook.md"), "---\nname: fastlook\ndescription: Quick look\nharness: fake\nmodel: fake/fast\nthinking: low\n---\nLook.");
    writeFileSync(join(repo, ".agents", "agents", "plain.md"), "---\nname: plain\ndescription: Plain\n---\nDo.");
    const list = async () => ((await (await call("GET", `/api/agent-defs?projectId=${p.id}`)).json()) as ListAgentDefsResponse).agents;
    const byName = (agents: Awaited<ReturnType<typeof list>>, name: string) => agents.find((a) => a.fields.name === name)!;
    let agents = await list();
    expect(byName(agents, "fastlook")).toMatchObject({
      available: true,
      problems: ["Runs on fake; other agents are off for sub-agents (only used by fake chats)", "Uses the chat's model and thinking (other models are off)"],
    });
    expect(byName(agents, "plain").problems).toEqual([]);
    service.updateSettings({ agent: { subagentOtherModels: true } });
    agents = await list();
    expect(byName(agents, "fastlook").problems).toEqual(["Runs on fake; other agents are off for sub-agents (only used by fake chats)"]);
    service.updateSettings({ agent: { subagentOtherHarnesses: true } });
    expect(byName(await list(), "fastlook").problems).toEqual([]);
  });
});

describe("one agent per name (I-220)", () => {
  it("lists a customization on its source, refuses a second one and a name another agent has (409)", async () => {
    const p = await project({ path: repo });
    mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
    writeFileSync(join(repo, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: pi scout\n---\nScout.");
    const put = (body: unknown) => call("PUT", "/api/agent-defs", { body });
    const message = async (res: Response) => ((await res.json()) as { error: string }).error;
    const clash = await put({ scope: "personal", projectId: p.id, fields: fields({ name: "scout", harness: "fake", prompt: "x" }) });
    expect(clash.status).toBe(409);
    expect(await message(clash)).toBe("pi already has an agent named scout — customize it instead");
    const customization = fields({ name: "scout", extends: "pi:scout", nicknames: ["Rex"] });
    const saved = await put({ scope: "personal", projectId: p.id, fields: customization });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SaveAgentDefResponse).agent).toMatchObject({ id: "personal:scout", customizes: "pi:scout" });
    const second = await put({ scope: "project", projectId: p.id, fields: customization });
    expect(second.status).toBe(409);
    expect(await message(second)).toContain("already customized");
    const listed = (await (await call("GET", `/api/agent-defs?projectId=${p.id}`)).json()) as ListAgentDefsResponse;
    expect(listed.agents.map((a) => [a.id, a.customizes, a.customizedBy])).toEqual([
      ["personal:scout", "pi:scout", null],
      ["pi:scout", null, "personal:scout"],
    ]);
    // Reset to Original.
    expect((await call("DELETE", "/api/agent-defs?scope=personal&name=scout")).status).toBe(204);
    const after = (await (await call("GET", `/api/agent-defs?projectId=${p.id}`)).json()) as ListAgentDefsResponse;
    expect(after.agents.map((a) => [a.id, a.customizedBy])).toEqual([["pi:scout", null]]);
  });
});

describe("agentDefs settings", () => {
  it("normalises switches, drops unknown projects, clears with null, and drops a deleted project's", async () => {
    const p = await project({ path: repo });
    const patch = { agentDefs: { disabled: ["Code Reviewer", "scout", "scout", ""], projects: { [p.id]: { Scout: true, other: false }, missing: { x: true } } } };
    expect((await call("PATCH", "/api/settings", { body: patch })).status).toBe(200);
    expect(service.getSettings().agentDefs).toEqual({ disabled: ["code-reviewer", "scout"], projects: { [p.id]: { scout: true, other: false } } });
    service.updateSettings({ agentDefs: { projects: { [p.id]: { other: null } } } } as never);
    expect(service.getSettings().agentDefs.projects).toEqual({ [p.id]: { scout: true } });
    expect((await call("PATCH", "/api/settings", { body: { agentDefs: { disabled: "scout" } } })).status).toBe(400);
    expect((await call("PATCH", "/api/settings", { body: { agentDefs: { projects: { [p.id]: { scout: "yes" } } } } })).status).toBe(400);
    await service.deleteProject(p.id);
    expect(service.getSettings().agentDefs).toEqual({ disabled: ["code-reviewer", "scout"], projects: {} });
  });
});

describe("paired devices", () => {
  async function pair(): Promise<string> {
    expect((await call("PATCH", "/api/auth/remote", { body: { enabled: true } })).status).toBe(200);
    const invite = (await (await call("POST", "/api/auth/invites")).json()) as PairingInvite;
    const grant = new URL(invite.link.replace("glade://", "http://x/")).searchParams.get("g")!;
    const pairing = call("POST", "/api/auth/pair", { body: { grant, deviceName: "Pro", deviceKind: "mac" }, remote: true });
    for (let i = 0; i < 400; i++) {
      const list = (await (await call("GET", "/api/auth/pending")).json()) as { id: string }[];
      if (list.length) {
        await call("POST", `/api/auth/pending/${list[0]!.id}`, { body: { allow: true } });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const paired = (await (await pairing).json()) as PairResponse;
    if (paired.status !== "paired") throw new Error("not paired");
    return paired.token;
  }

  it("read the agents but can't change them", async () => {
    const token = await pair();
    expect((await call("GET", "/api/agent-defs", { token, remote: true })).status).toBe(200);
    expect((await call("GET", "/api/agent-defs/tools?harness=pi", { token, remote: true })).status).toBe(200);
    for (const [method, path, body] of [
      ["PUT", "/api/agent-defs", { scope: "personal", fields: fields({ name: "x" }) }],
      ["DELETE", "/api/agent-defs?scope=personal&name=x", undefined],
      ["POST", "/api/agent-defs/describe", { name: "x", harness: "pi", prompt: "p" }],
    ] as const) {
      const res = await call(method, path, { token, remote: true, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ code: "local_only", error: expect.stringContaining("Change this on") });
    }
  });
});
