import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, FileSearchResponse, HarnessDefaults, SlashCommand } from "@glade/protocol";
import { FAKE_COMMANDS } from "../src/harness/fake/fake-harness.js";
import { PiHarness } from "../src/harness/pi/pi-harness.js";
import { translateDefaults } from "../src/harness/pi/translate.js";
import { createApp } from "../src/http/app.js";
import { listFolderFiles, rankFiles } from "../src/services/file-index.js";
import { FolderInfoService } from "../src/services/folder-info.js";
import { createTestEnv, type TestEnv } from "./helpers.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "glade-folder-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, text = "x") {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const paths = (entries: FileEntry[]) => entries.map((e) => (e.kind === "dir" ? `${e.path}/` : e.path));

describe("listFolderFiles", () => {
  it("uses git in a repo: tracked + untracked, .gitignore respected", async () => {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    write(tmp, ".gitignore", "node_modules\n*.log\n");
    write(tmp, "src/app.ts");
    write(tmp, "Composer.tsx");
    write(tmp, "debug.log");
    write(tmp, "node_modules/pkg/index.js");
    execFileSync("git", ["add", "src/app.ts"], { cwd: tmp });
    const { entries, truncated } = await listFolderFiles(tmp);
    expect(truncated).toBe(false);
    expect(paths(entries).sort()).toEqual([".gitignore", "Composer.tsx", "src/", "src/app.ts"]);
  });

  it("walks non-git folders, skipping node_modules/.git/dist", async () => {
    write(tmp, "a/b/c.txt");
    write(tmp, "node_modules/x.js");
    write(tmp, "dist/out.js");
    write(tmp, "readme.md");
    const { entries } = await listFolderFiles(tmp);
    expect(paths(entries).sort()).toEqual(["a/", "a/b/", "a/b/c.txt", "readme.md"]);
  });
});

describe("rankFiles", () => {
  const entries: FileEntry[] = [
    "apps/web/src/features/chat/composer-utils.ts",
    "apps/web/src/features/chat/Composer.test.tsx",
    "apps/web/src/features/chat/Composer.tsx",
    "apps/web/src/features/chat/ChatView.tsx",
    "docs/components.md",
    "src/app.ts",
    "src/api.ts",
  ].map((path) => ({ path, kind: "file" as const }));
  const all: FileEntry[] = [...entries, { path: "src", kind: "dir" }, { path: "apps", kind: "dir" }];

  it("puts the basename match first (@comp → Composer.tsx)", () => {
    expect(rankFiles(all, "comp", 10)[0]!.path).toBe("apps/web/src/features/chat/Composer.tsx");
    // Shorter basenames win ties, so the exact file name beats its test/utils siblings.
    expect(paths(rankFiles(all, "comp", 10))).toEqual([
      "apps/web/src/features/chat/Composer.tsx",
      "docs/components.md",
      "apps/web/src/features/chat/Composer.test.tsx",
      "apps/web/src/features/chat/composer-utils.ts",
    ]);
  });
  it("falls back to path and fuzzy matches, capped", () => {
    expect(paths(rankFiles(all, "chat", 10))[0]).toBe("apps/web/src/features/chat/ChatView.tsx");
    expect(paths(rankFiles(all, "cmpsr", 10))[0]).toBe("apps/web/src/features/chat/Composer.tsx");
    expect(rankFiles(all, "zzz", 10)).toEqual([]);
    expect(rankFiles(all, "a", 2)).toHaveLength(2);
  });
  it("completes directories stepwise with path queries", () => {
    // Paths merely containing "src/" (or fuzzy ones) only show when nothing starts with it.
    expect(paths(rankFiles(all, "src/", 10))).toEqual(["src/api.ts", "src/app.ts"]);
    expect(paths(rankFiles(all, "chat/c", 10))[0]).toBe("apps/web/src/features/chat/ChatView.tsx");
    expect(paths(rankFiles(all, "src/ap", 10))).toEqual(["src/api.ts", "src/app.ts"]);
  });
  it("lists the top of the tree for an empty query", () => {
    expect(paths(rankFiles(all, "", 3))).toEqual(["apps/", "src/", "docs/components.md"]);
  });
});

describe("translateDefaults", () => {
  it("reads pi's default model and thinking level from get_state", () => {
    expect(translateDefaults({ model: { provider: "anthropic", id: "claude-opus-5-5", reasoning: true }, thinkingLevel: "high" })).toEqual({
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      thinkingLevel: "high",
    });
    expect(translateDefaults({ model: null, thinkingLevel: "bogus" })).toEqual({ model: null, thinkingLevel: null });
  });
});

describe("PiHarness defaults + folder commands", () => {
  /** A fake `pi` answering the RPC requests we send. */
  function fakePi(): string {
    const script = join(tmp, "fake-pi.mjs");
    writeFileSync(
      script,
      `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const data =
      req.type === "get_available_models" ? { models: [{ provider: "anthropic", id: "claude-opus-5-5", name: "Opus", reasoning: true, input: ["text"] }] } :
      req.type === "get_state" ? { model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "low" } :
      req.type === "get_commands" ? { commands: [{ name: "cwd-" + require("node:path").basename(process.cwd()), source: "prompt" }] } : {};
    process.stdout.write(JSON.stringify({ type: "response", id: req.id, command: req.type, success: true, data }) + "\\n");
  }
});
`.replace('require("node:path").basename(process.cwd())', 'process.cwd().split("/").pop()'),
    );
    chmodSync(script, 0o755);
    return script;
  }

  it("reports pi's default model/thinking level and lists commands per folder", async () => {
    const piPath = fakePi();
    const harness = new PiHarness({
      config: () => ({ piPath, extraArgs: [], autoCompaction: true, autoRetry: true }),
      utilityCwd: tmp,
    });
    expect(await harness.getDefaults()).toEqual<HarnessDefaults>({ model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "low" });
    mkdirSync(join(tmp, "proj"));
    expect(await harness.listFolderCommands(join(tmp, "proj"))).toEqual<SlashCommand[]>([{ name: "cwd-proj", source: "prompt" }]);
  });
});

describe("FolderInfoService + routes", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function setup(listFiles = vi.fn(async (cwd: string) => ({ entries: [{ path: `${cwd.split("/").pop()}.ts`, kind: "file" as const }], truncated: false }))) {
    const projectDir = join(tmp, "myproj");
    mkdirSync(projectDir);
    const project = env.service.createProject({ path: projectDir });
    const folderInfo = new FolderInfoService({
      harness: env.harness,
      scratchDir: join(env.dir, "scratch"),
      projectPath: (id) => env.store.getProject(id)?.path,
      listFiles,
    });
    const { app } = createApp({ service: env.service, folderInfo });
    const get = (path: string) => app.request(path, { headers: { host: "127.0.0.1:4317" } });
    return { project, folderInfo, get, listFiles };
  }

  it("serves folder commands, files and defaults", async () => {
    const { project, get, listFiles } = setup();
    const commands = await get(`/api/commands?projectId=${project.id}`);
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual(FAKE_COMMANDS);
    const files = (await (await get(`/api/files?projectId=${project.id}&q=my`)).json()) as FileSearchResponse;
    expect(files).toEqual({ entries: [{ path: "myproj.ts", kind: "file" }], truncated: false });
    // Scratch folder when no project; cached listing per folder.
    const scratch = (await (await get(`/api/files?q=`)).json()) as FileSearchResponse;
    expect(scratch.entries[0]!.path).toBe("scratch.ts");
    await get(`/api/files?projectId=${project.id}&q=x`);
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(await (await get("/api/models/default")).json()).toEqual({ model: { provider: "fake", id: expect.any(String) }, thinkingLevel: null });
    // The regular API still works next to these routes.
    expect((await get("/api/models")).status).toBe(200);
  });

  it("404s for unknown projects", async () => {
    const { get } = setup();
    expect((await get("/api/commands?projectId=nope")).status).toBe(404);
    expect((await get("/api/files?projectId=nope&q=a")).status).toBe(404);
  });

  it("caches folder commands and refreshes on demand", async () => {
    const { folderInfo, project } = setup();
    const spy = vi.spyOn(env.harness, "listFolderCommands");
    await folderInfo.listCommands(project.id);
    await folderInfo.listCommands(project.id);
    expect(spy).toHaveBeenCalledTimes(1);
    await folderInfo.listCommands(project.id, true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
