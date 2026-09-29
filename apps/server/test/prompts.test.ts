/**
 * Saved prompts (I-098): stored in settings.json through PATCH /api/settings, validated, pushed
 * to clients, and dropped with their project.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SavedPrompt, Settings } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { Store } from "../src/store/store.js";
import { createTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const prompt = (over: Partial<SavedPrompt> = {}): SavedPrompt => ({ id: "p1", name: "Review diff", body: "Review this diff.", projectId: null, ...over });

describe("saved prompts", () => {
  it("defaults to none and persists a patched list across restarts", () => {
    expect(env.service.getSettings().prompts).toEqual([]);
    const settings = env.service.updateSettings({ prompts: [prompt({ name: "  Review diff  ", description: " look " })] });
    expect(settings.prompts).toEqual([{ id: "p1", name: "Review diff", description: "look", body: "Review this diff.", projectId: null }]);
    expect(env.messages.some((m) => m.type === "settings" && m.settings.prompts.length === 1)).toBe(true);
    env.store.flush();
    const reopened = new Store(join(env.dir, "data"), 0);
    expect(reopened.getSettings().prompts.map((p) => p.id)).toEqual(["p1"]);
    // Other patches leave them alone; a new list replaces the old one.
    env.service.updateSettings({ general: { generateTitles: false } });
    expect(env.service.getSettings().prompts).toHaveLength(1);
    env.service.updateSettings({ prompts: [] });
    expect(env.service.getSettings().prompts).toEqual([]);
  });

  it("rejects invalid lists with a 400 over HTTP", async () => {
    const { app } = createApp({ service: env.service });
    const patch = (body: unknown) =>
      app.request("/api/settings", { method: "PATCH", headers: { host: "127.0.0.1:4317", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ prompts: [prompt({ body: "  " })] })).status).toBe(400);
    expect((await patch({ prompts: [prompt({ name: "" })] })).status).toBe(400);
    expect((await patch({ prompts: [prompt(), prompt()] })).status).toBe(400);
    expect((await patch({ prompts: "nope" })).status).toBe(400);
    const ok = await patch({ prompts: [prompt()] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Settings).prompts).toHaveLength(1);
  });

  it("deleting a project deletes its prompts", async () => {
    const path = join(env.dir, "proj");
    mkdirSync(path);
    const project = env.service.createProject({ path });
    env.service.updateSettings({ prompts: [prompt(), prompt({ id: "p2", name: "Tests", projectId: project.id })] });
    env.messages.length = 0;
    await env.service.deleteProject(project.id);
    expect(env.service.getSettings().prompts.map((p) => p.id)).toEqual(["p1"]);
    expect(env.messages.some((m) => m.type === "settings")).toBe(true);
  });
});
