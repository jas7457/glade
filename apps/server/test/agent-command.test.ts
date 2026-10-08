/**
 * I-201: a custom command per agent (Advanced on the agent's page). Real child processes, but only
 * fakes: a wrapper script (records its arguments, then execs a fake agent) and fake pi / Codex /
 * Claude Code programs. Never a real agent, updater or model.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, type AgentCatalogEntry, type AgentCommandLine, type AgentCommandTestResult, type Settings } from "@glade/protocol";
import { agentCommandWatcher, customCommandFn } from "../src/harness/agent-command.js";
import { buildAgentCatalog } from "../src/harness/agent-catalog.js";
import { ClaudeHarness } from "../src/harness/claude/claude-harness.js";
import { claudeShim } from "../src/harness/claude/shim.js";
import { CodexHarness } from "../src/harness/codex/codex-harness.js";
import { spawnCodexTransport } from "../src/harness/codex/rpc.js";
import { PiHarness } from "../src/harness/pi/pi-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { findExecutable } from "../src/harness/which.js";
import { sanitizeAgentsPatch } from "../src/services/app/agent-settings.js";
import { AgentVersionsService } from "../src/services/agent-versions/service.js";
import { defaultReadInstalled, testAgentCommand } from "../src/services/agent-versions/versions.js";
import type { ShellRun } from "../src/services/update-job.js";
import { createApp } from "../src/http/app.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import { FakeClaudeSdk } from "./fixtures/fake-claude-sdk.js";
import { FakeCodexAppServer } from "./fixtures/fake-codex-app-server.js";
import { createTestEnv, until } from "./helpers.js";

let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-cmd-"));
  savedPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** `mywrapper <agent> [flags…]`: appends its arguments (JSON) to wrapper.log, drops the agent name, execs the fake agent. */
function wrapper(agentPath: string, name = "mywrapper"): string {
  return script(
    name,
    `#!/bin/sh
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${JSON.stringify(join(dir, "wrapper.log"))} "$@"
shift
exec ${JSON.stringify(agentPath)} "$@"
`,
  );
}
const wrapperCalls = (): string[][] =>
  existsSync(join(dir, "wrapper.log"))
    ? readFileSync(join(dir, "wrapper.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[])
    : [];

/** A fake pi: records its argv per kind (`rpc`, `p`, `json`), answers RPC, one-shot and side questions. */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("0.80.1"); process.exit(0); }
const kind = argv.includes("-p") ? (argv.includes("json") ? "json" : "p") : "rpc";
fs.appendFileSync(${JSON.stringify("__DIR__")} + "/pi-" + kind + ".log", JSON.stringify(argv) + "\\n");
if (kind === "p") { console.log("A title"); process.exit(0); }
if (kind === "json") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Aside" }], stopReason: "stop" } }));
    process.exit(0);
  });
} else {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const data = m.type === "get_available_models" ? { models: [{ id: "m1", name: "M1", provider: "fake" }] } : {};
      process.stdout.write(JSON.stringify({ type: "response", id: m.id, command: m.type, success: true, data }) + "\\n");
    }
  });
}
`;
const piCalls = (kind: string): string[][] =>
  existsSync(join(dir, `pi-${kind}.log`))
    ? readFileSync(join(dir, `pi-${kind}.log`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[])
    : [];

function settingsWith(agents: Settings["agents"]): Settings {
  return { ...defaultSettings(), agents };
}

describe("settings: advanced + command (I-201)", () => {
  it("trims commands, stores empty as null, refuses invalid ones with the reason", () => {
    expect(sanitizeAgentsPatch({ agents: { pi: { advanced: true, command: "  mywrapper pi  " } } })).toEqual({ agents: { pi: { advanced: true, command: "mywrapper pi" } } });
    expect(sanitizeAgentsPatch({ agents: { pi: { command: "   " } } })).toEqual({ agents: { pi: { command: null } } });
    expect(sanitizeAgentsPatch({ agents: { pi: { command: null } } })).toEqual({ agents: { pi: { command: null } } });
    expect(sanitizeAgentsPatch({ general: { generateTitles: false } })).toEqual({ general: { generateTitles: false } });
    expect(() => sanitizeAgentsPatch({ agents: { pi: { command: "pi --mode json" } } })).toThrow("`--mode` is set by Glade: remove it from the command.");
    expect(() => sanitizeAgentsPatch({ agents: { pi: { command: "pi | tee" } } })).toThrow(/without a shell/);
    expect(() => sanitizeAgentsPatch({ agents: { pi: { advanced: "yes" } } } as never)).toThrow(/true or false/);
    expect(() => sanitizeAgentsPatch({ agents: { pi: { command: 3 } } } as never)).toThrow(/string or null/);
    expect(() => sanitizeAgentsPatch({ agents: { fake: { command: "x" } } })).toThrow(/Only pi, Claude Code and Codex/);
  });

  it("PATCH /settings saves them (400 with the reason when refused); switching Advanced off keeps the command", async () => {
    const env = createTestEnv();
    try {
      const auth = new AuthService({ db: env.store.db, environmentId: env.service.environment.id, environmentName: () => "Mac", addresses: () => [] });
      const { app } = createApp({ service: env.service, auth });
      const patch = (body: unknown) =>
        app.request(
          "/api/settings",
          { method: "PATCH", headers: { host: "127.0.0.1:4317", "content-type": "application/json" }, body: JSON.stringify(body) },
          { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
        );
      expect((await patch({ agents: { pi: { advanced: true, command: "mywrapper pi --offline" } } })).status).toBe(200);
      const bad = await patch({ agents: { pi: { command: "mywrapper pi --session x" } } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("`--session` is set by Glade: remove it from the command.");
      expect((await patch({ agents: { pi: { advanced: false } } })).status).toBe(200);
      expect(env.service.getSettings().agents.pi).toEqual({ advanced: false, command: "mywrapper pi --offline" });
    } finally {
      await env.cleanup();
    }
  });

  it("the watcher reports agents whose effective command changed", () => {
    let settings = settingsWith({});
    const changed = agentCommandWatcher(() => settings, ["pi", "codex"]);
    expect(changed()).toEqual([]);
    settings = settingsWith({ codex: { command: "mywrapper codex" } }); // saved, Advanced off: no change
    expect(changed()).toEqual([]);
    settings = settingsWith({ codex: { advanced: true, command: "mywrapper codex" } });
    expect(changed()).toEqual(["codex"]);
    expect(changed()).toEqual([]);
    settings = settingsWith({ codex: { advanced: false, command: "mywrapper codex" } });
    expect(changed()).toEqual(["codex"]);
  });
});

describe("pi through a custom command (I-201)", () => {
  let settings: Settings;
  let pi: string;
  beforeEach(() => {
    pi = script("fake-pi", FAKE_PI.replace("__DIR__", dir));
    wrapper(pi);
    // The wrapper is found on the PATH by name.
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
    settings = settingsWith({ pi: { advanced: true, command: "mywrapper pi --offline" } });
  });
  const harness = () => new PiHarness({ command: pi, utilityCwd: dir, extensionPath: () => null, customCommand: customCommandFn(() => settings, "pi"), modelsSettleMs: 0 });

  it("starts RPC, model listing, one-shot and side-question processes as `mywrapper pi <flags> <Glade's args>`", async () => {
    const h = harness();
    expect(h.isInstalled()).toBe(true);
    expect((await h.listModels()).map((m) => m.id)).toEqual(["m1"]);
    expect(wrapperCalls()[0]).toEqual(["pi", "--offline", "--mode", "rpc", "--no-session", "--no-skills"]);
    expect(piCalls("rpc")[0]).toEqual(["--offline", "--mode", "rpc", "--no-session", "--no-skills"]);

    expect(await h.complete({ prompt: "name it", cwd: dir, model: null })).toBe("A title");
    expect(wrapperCalls()[1]!.slice(0, 4)).toEqual(["pi", "--offline", "-p", "--no-session"]);

    const answer = await h.answerSideQuestion({ prompt: "q", systemPrompt: "s", model: null, cwd: dir, signal: new AbortController().signal, onDelta: () => {} });
    expect(answer).toEqual({ answer: "Aside" });
    expect(wrapperCalls()[2]!.slice(0, 5)).toEqual(["pi", "--offline", "-p", "--mode", "json"]);

    const session = await h.openSession({ cwd: dir, sessionRef: null });
    await session.dispose();
    expect(wrapperCalls()[3]!.slice(0, 4)).toEqual(["pi", "--offline", "--mode", "rpc"]);
  });

  it("Advanced off: Glade's own pi, while the custom command stays saved", async () => {
    settings = settingsWith({ pi: { advanced: false, command: "mywrapper pi --offline" } });
    const h = harness();
    await h.listModels();
    expect(wrapperCalls()).toEqual([]);
    expect(piCalls("rpc")[0]).toEqual(["--mode", "rpc", "--no-session", "--no-skills"]);
    // Back on: the wrapper again, from the next process on.
    settings = settingsWith({ pi: { advanced: true, command: "mywrapper pi --offline" } });
    await h.listModels(true);
    expect(wrapperCalls()).toHaveLength(1);
  });

  it("is installed only when the custom program is on the PATH; the catalog shows the command and what it looked for", () => {
    settings = settingsWith({ pi: { advanced: true, command: "no-such-wrapper pi" } });
    const h = harness();
    expect(h.isInstalled()).toBe(false);
    const registry = new HarnessRegistry([h]);
    const [entry] = buildAgentCatalog({ harnesses: registry, settings }) as [AgentCatalogEntry];
    expect(entry).toMatchObject({ id: "pi", command: "no-such-wrapper pi", custom: true, lookedFor: ["no-such-wrapper"], installed: false });
    settings = settingsWith({ pi: { advanced: false, command: "no-such-wrapper pi" } });
    const [plain] = buildAgentCatalog({ harnesses: registry, settings }) as [AgentCatalogEntry];
    expect(plain).toMatchObject({ command: "pi", lookedFor: ["pi"] });
    expect(plain.custom).toBeUndefined();
  });
});

describe("Codex through a custom command (I-201)", () => {
  it("spawns `<program> <args> app-server` with the real transport", async () => {
    const fake = script(
      "fake-codex",
      `#!/usr/bin/env node
console.log(JSON.stringify({ id: 1, result: process.argv.slice(2) }));
setTimeout(() => process.exit(0), 50);
`,
    );
    wrapper(fake);
    const transport = spawnCodexTransport({ executable: join(dir, "mywrapper"), leadingArgs: ["codex", "-c", "x=y"], cwd: dir, env: process.env });
    const messages: unknown[] = [];
    transport.onMessage((m) => messages.push(m));
    await until(() => messages.length > 0, 3000);
    expect(wrapperCalls()[0]).toEqual(["codex", "-c", "x=y", "app-server"]);
    expect(messages[0]).toEqual({ id: 1, result: ["-c", "x=y", "app-server"] });
    transport.close();
  });

  it("the harness looks up the custom program and passes its arguments; reload() restarts the app-server", async () => {
    let settings = settingsWith({ codex: { advanced: true, command: "mywrapper codex -c a=b" } });
    const spawns: Array<{ executable: string; leadingArgs: string[] }> = [];
    const looked: string[] = [];
    const codex = new FakeCodexAppServer();
    const h = new CodexHarness({
      utilityCwd: dir,
      which: (c) => (looked.push(c), true),
      findExecutable: (c) => `/opt/bin/${c}`,
      customCommand: customCommandFn(() => settings, "codex"),
      connect: (spawn) => (spawns.push({ executable: spawn.executable, leadingArgs: spawn.leadingArgs }), codex.connect()),
    });
    try {
      expect(h.isInstalled()).toBe(true);
      expect(looked).toEqual(["mywrapper"]);
      await h.server.ensure();
      expect(spawns).toEqual([{ executable: "/opt/bin/mywrapper", leadingArgs: ["codex", "-c", "a=b"] }]);
      settings = settingsWith({ codex: { advanced: false, command: "mywrapper codex -c a=b" } });
      h.reload();
      await h.server.ensure();
      expect(spawns[1]).toEqual({ executable: "/opt/bin/codex", leadingArgs: [] });
    } finally {
      await h.dispose();
    }
  });
});

describe("Claude Code through a custom command (I-201)", () => {
  it("hands the SDK a generated script that execs the wrapper with its arguments", async () => {
    const fakeClaude = script("fake-claude", `#!/bin/sh\necho "claude got: $*"\n`);
    wrapper(fakeClaude, "mywrapper");
    let settings = settingsWith({ claude: { advanced: true, command: "mywrapper claude --add-dir '/my dir'" } });
    const sdk = new FakeClaudeSdk();
    const shimDir = join(dir, "shims");
    const h = new ClaudeHarness({
      sdk,
      utilityCwd: dir,
      which: () => true,
      findExecutable: (c) => findExecutable(c, dir),
      customCommand: customCommandFn(() => settings, "claude"),
      shimDir,
    });
    await h.listModels();
    const path = sdk.queries[0]!.options.pathToClaudeCodeExecutable!;
    expect(path.startsWith(shimDir)).toBe(true);
    // What the SDK would do: run it with its own flags.
    const out = execFileSync(path, ["--output-format", "stream-json", "--verbose"], { encoding: "utf8" });
    expect(out.trim()).toBe("claude got: --add-dir /my dir --output-format stream-json --verbose");
    expect(wrapperCalls()[0]).toEqual(["claude", "--add-dir", "/my dir", "--output-format", "stream-json", "--verbose"]);
    // The same command reuses its script; a missing one is written again.
    expect(claudeShim(join(dir, "mywrapper"), ["claude", "--add-dir", "/my dir"], shimDir)).toBe(path);
    rmSync(shimDir, { recursive: true, force: true });
    expect(claudeShim(join(dir, "mywrapper"), ["claude", "--add-dir", "/my dir"], shimDir)).toBe(path);

    // A wrapper without arguments is used directly; Advanced off: `claude` itself.
    settings = settingsWith({ claude: { advanced: true, command: "mywrapper" } });
    await h.listModels(true);
    expect(sdk.queries[1]!.options.pathToClaudeCodeExecutable).toBe(join(dir, "mywrapper"));
    settings = settingsWith({ claude: { advanced: false, command: "mywrapper" } });
    script("claude", "#!/bin/sh\n");
    await h.listModels(true);
    expect(sdk.queries[2]!.options.pathToClaudeCodeExecutable).toBe(join(dir, "claude"));
  });
});

describe("versions and updates through a custom command (I-201)", () => {
  it("reads the installed version with `<command> --version`", async () => {
    const pi = script("fake-pi", FAKE_PI.replace("__DIR__", dir));
    wrapper(pi);
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
    const custom: Record<string, AgentCommandLine | null> = { pi: { program: "mywrapper", args: ["pi"] } };
    const read = defaultReadInstalled({}, (h) => custom[h] ?? null);
    expect(await read("pi")).toMatchObject({ installed: true, version: "0.80.1" });
    expect(wrapperCalls()[0]).toEqual(["pi", "--version"]);
    custom.pi = { program: "no-such-wrapper", args: ["pi"] };
    expect(await read("pi")).toEqual({ installed: false });
  });

  it("Update runs the agent's updater through the custom command (never a real updater)", async () => {
    const commands: string[] = [];
    const shell: ShellRun = async (command) => (commands.push(command), 0);
    let custom: AgentCommandLine | null = { program: "mywrapper", args: ["pi"] };
    const av = new AgentVersionsService({
      busyChats: () => 0,
      readInstalled: async () => ({ installed: true, version: "0.80.1", output: "0.80.1" }),
      fetchText: async () => JSON.stringify({ version: "0.80.2" }),
      claudeChannel: () => "latest",
      shell,
      customCommand: (h) => (h === "pi" ? custom : null),
      // index.ts merges the defaults into the testing overrides: they must not win over a custom command.
      updateCommands: { pi: "pi update self", claude: "claude update", codex: "codex update" },
    });
    try {
      expect(av.status().agents.find((a) => a.harness === "pi")!.updateCommand).toBe("mywrapper pi update self");
      av.startUpdate("pi");
      await av.settled;
      expect(commands).toEqual(["mywrapper pi update self"]);
      custom = null;
      expect(av.status().agents.find((a) => a.harness === "pi")!.updateCommand).toBe("pi update self");
      expect(av.status().agents.find((a) => a.harness === "claude")!.updateCommand).toBe("claude update");
    } finally {
      av.dispose();
    }
  });

  it("Test runs `<command> --version` and explains failures", async () => {
    const pi = script("fake-pi", FAKE_PI.replace("__DIR__", dir));
    wrapper(pi);
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
    expect(await testAgentCommand("pi", "mywrapper pi")).toEqual<AgentCommandTestResult>({ ok: true, command: "mywrapper pi --version", version: "0.80.1", output: "0.80.1" });
    expect(await testAgentCommand("pi", "missing-wrapper pi")).toMatchObject({ ok: false, error: "`missing-wrapper` wasn't found on this device's PATH." });
    expect(await testAgentCommand("pi", "mywrapper pi --mode json")).toMatchObject({ ok: false, error: "`--mode` is set by Glade: remove it from the command." });
    script("broken", "#!/bin/sh\necho nope >&2\nexit 2\n");
    expect(await testAgentCommand("pi", "broken")).toMatchObject({ ok: false, command: "broken --version", output: "nope", error: "It exited with code 2." });
    script("quiet", "#!/bin/sh\necho hello\n");
    expect(await testAgentCommand("codex", "quiet")).toMatchObject({ ok: false, error: "It ran, but didn't print a version." });
    expect(await testAgentCommand("acp-x", "x")).toMatchObject({ ok: false });
  });

  it("POST /api/agent-command/test is for the host itself", async () => {
    const env = createTestEnv();
    try {
      const auth = new AuthService({ db: env.store.db, environmentId: env.service.environment.id, environmentName: () => "Mac", addresses: () => [] });
      const { app } = createApp({ service: env.service, auth });
      const res = await app.request(
        "/api/agent-command/test",
        { method: "POST", headers: { host: "127.0.0.1:4317", "content-type": "application/json" }, body: JSON.stringify({ harness: "pi", command: "pi --mode x" }) },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: false, error: "`--mode` is set by Glade: remove it from the command." });
      const remote = await app.request(
        "/api/agent-command/test",
        { method: "POST", headers: { host: "127.0.0.1:4317", origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify({ harness: "pi", command: "pi" }) },
        { incoming: { socket: { remoteAddress: "100.64.0.9" } } },
      );
      expect(remote.status).toBeGreaterThanOrEqual(401);
    } finally {
      await env.cleanup();
    }
  });
});
