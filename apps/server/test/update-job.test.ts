/**
 * I-154: the Update Now job with stubbed git and shell (success, dirty repo, not on main, can't
 * fast-forward, a failure mid-build, cancel, one job at a time, the log ring buffer) and the API
 * shape (`/api/version/update*`). Nothing is pulled, installed or built.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildInfo, UpdateJobStatus } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import type { GitRun } from "../src/services/update-check.js";
import { LOG_LINES, UPDATE_UNAVAILABLE_DEV, UpdateJob, stepScript, throttle, updateEnv, type ShellRun } from "../src/services/update-job.js";
import { Store } from "../src/store/store.js";

const REPO = "/src/glade";
const BUILD: BuildInfo = { commit: "a".repeat(40), shortCommit: "aaaaaaa", builtAt: "2026-09-26T10:00:00.000Z", dirty: false, repoPath: REPO, kind: "release" };

interface Stub {
  status?: string;
  branch?: string;
  fetch?: Error;
  ff?: boolean;
  /** Exit code per command (default 0). */
  exits?: Record<string, number>;
  /** Commands that wait until released (or aborted). */
  hold?: string[];
}

function makeJob(stub: Stub = {}, extra: { unavailableReason?: string | null; exists?: boolean } = {}) {
  const gitCalls: string[] = [];
  const commands: { command: string; cwd: string }[] = [];
  const release = new Map<string, () => void>();
  const git: GitRun = async (args) => {
    const key = args.join(" ");
    gitCalls.push(key);
    if (key.startsWith("status")) return stub.status ?? "";
    if (key.startsWith("rev-parse --abbrev-ref")) return `${stub.branch ?? "main"}\n`;
    if (key.startsWith("fetch")) {
      if (stub.fetch) throw stub.fetch;
      return "";
    }
    if (key.startsWith("merge-base")) {
      if (stub.ff === false) throw new Error("exit 1");
      return "";
    }
    throw new Error(`unexpected git ${key}`);
  };
  const shell: ShellRun = async (command, cwd, onOutput, signal) => {
    commands.push({ command, cwd });
    onOutput(`running ${command}\n`);
    if (stub.hold?.includes(command)) {
      await new Promise<void>((resolve) => {
        release.set(command, resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (signal.aborted) return null;
    }
    return stub.exits?.[command] ?? 0;
  };
  const job = new UpdateJob({
    build: () => BUILD,
    unavailableReason: extra.unavailableReason === undefined ? null : extra.unavailableReason,
    git,
    shell,
    exists: () => extra.exists ?? true,
    now: () => new Date("2026-09-27T12:00:00.000Z"),
  });
  const seen: UpdateJobStatus[] = [];
  job.onChange((s) => seen.push(s));
  return { job, gitCalls, commands, release, seen };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!check()) throw new Error("timed out");
};

describe("UpdateJob", () => {
  it("runs the guards, then pull → install → tauri:install in the repo folder", async () => {
    const { job, gitCalls, commands, seen } = makeJob();
    expect(job.status()).toMatchObject({ available: true, state: "idle", canCancel: false });
    expect(job.start()).toMatchObject({ state: "checking", canCancel: true });
    await job.done;
    expect(gitCalls).toEqual(["status --porcelain --untracked-files=no", "rev-parse --abbrev-ref HEAD", "fetch origin main", "merge-base --is-ancestor HEAD origin/main"]);
    expect(commands).toEqual([
      { command: "git pull --ff-only", cwd: REPO },
      { command: "pnpm install --frozen-lockfile", cwd: REPO },
      { command: "pnpm tauri:install", cwd: REPO },
    ]);
    const status = job.status();
    expect(status.state).toBe("installed");
    expect(status.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(status.log).toContain("$ pnpm tauri:install");
    expect(status.log).toContain("running pnpm tauri:install");
    expect(status.endedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(seen.map((s) => s.state)).toContain("running");
    // Installed: restart to use it; no second run.
    expect(() => job.start()).toThrow(/restart Glade/);
  });

  it("refuses a repo with uncommitted changes", async () => {
    const { job, commands } = makeJob({ status: " M a.ts\n M b.ts\n" });
    job.start();
    await job.done;
    expect(job.status()).toMatchObject({ state: "refused", error: expect.stringContaining("uncommitted changes (2 files)") });
    expect(commands).toEqual([]);
  });

  it("refuses when the repo isn't on main", async () => {
    const { job, gitCalls } = makeJob({ branch: "feature/x" });
    job.start();
    await job.done;
    expect(job.status()).toMatchObject({ state: "refused", error: expect.stringContaining("branch feature/x, not main") });
    expect(gitCalls).not.toContain("fetch origin main");
  });

  it("refuses when main can't fast-forward", async () => {
    const { job, commands } = makeJob({ ff: false });
    job.start();
    await job.done;
    expect(job.status()).toMatchObject({ state: "refused", error: expect.stringContaining("can't fast-forward") });
    expect(commands).toEqual([]);
  });

  it("refuses when the repo folder isn't on this Mac", async () => {
    const { job, gitCalls } = makeJob({}, { exists: false });
    job.start();
    await job.done;
    expect(job.status()).toMatchObject({ state: "refused", error: expect.stringContaining("isn't on this Mac") });
    expect(gitCalls).toEqual([]);
  });

  it("fails when origin can't be fetched", async () => {
    const { job } = makeJob({ fetch: new Error("Could not resolve host") });
    job.start();
    await job.done;
    expect(job.status()).toMatchObject({ state: "failed", error: "Couldn't fetch origin: Could not resolve host" });
  });

  it("stops at a failing build and keeps the log tail", async () => {
    const { job, commands } = makeJob({ exits: { "pnpm tauri:install": 101 } });
    job.start();
    await job.done;
    const status = job.status();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("exited with 101");
    expect(status.steps.map((s) => s.state)).toEqual(["done", "done", "failed"]);
    expect(status.log.at(-1)).toBe("running pnpm tauri:install");
    expect(commands).toHaveLength(3);
    // A failed job can be retried.
    expect(() => job.start()).not.toThrow();
  });

  it("stops after a failing install without building", async () => {
    const { job, commands } = makeJob({ exits: { "pnpm install --frozen-lockfile": 1 } });
    job.start();
    await job.done;
    expect(job.status().steps.map((s) => s.state)).toEqual(["done", "failed", "pending"]);
    expect(commands.map((c) => c.command)).not.toContain("pnpm tauri:install");
  });

  it("cancels before the install step, but not during it", async () => {
    const { job, commands } = makeJob({ hold: ["pnpm install --frozen-lockfile"] });
    job.start();
    expect(() => job.start()).toThrow(/already running/);
    await until(() => commands.length === 2);
    expect(job.status().canCancel).toBe(true);
    job.cancel();
    await job.done;
    expect(job.status()).toMatchObject({ state: "cancelled", canCancel: false });
    expect(job.status().steps.map((s) => s.state)).toEqual(["done", "cancelled", "cancelled"]);
    expect(commands.map((c) => c.command)).not.toContain("pnpm tauri:install");
    expect(() => job.cancel()).toThrow(/No update is running/);

    const second = makeJob({ hold: ["pnpm tauri:install"] });
    second.job.start();
    await until(() => second.commands.length === 3);
    expect(second.job.status().canCancel).toBe(false);
    expect(() => second.job.cancel()).toThrow(/can't be cancelled/);
    second.release.get("pnpm tauri:install")!();
    await second.job.done;
    expect(second.job.status().state).toBe("installed");
  });

  it("isn't available on a development server", () => {
    const { job } = makeJob({}, { unavailableReason: UPDATE_UNAVAILABLE_DEV });
    expect(job.status()).toMatchObject({ available: false, unavailableReason: UPDATE_UNAVAILABLE_DEV, state: "idle" });
    expect(() => job.start()).toThrow(/Only the Glade app/);
  });

  it("keeps only the last lines of output", async () => {
    const shell: ShellRun = async (_c, _cwd, onOutput) => {
      onOutput(Array.from({ length: LOG_LINES + 50 }, (_, i) => `line ${i}`).join("\n") + "\n50%\r100%\n");
      return 0;
    };
    const big = new UpdateJob({ build: () => BUILD, unavailableReason: null, git: async (args) => (args[0] === "rev-parse" ? "main" : ""), shell, exists: () => true });
    big.start();
    await big.done;
    const log = big.status().log;
    expect(log).toHaveLength(LOG_LINES);
    expect(log.at(-1)).toBe("100%");
  });
});

describe("update helpers", () => {
  it("sources cargo's env before the command", () => {
    expect(stepScript("pnpm tauri:install")).toBe('if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi\npnpm tauri:install');
  });

  it("doesn't hand the server's own config to the build, but keeps the rest", () => {
    const env = updateEnv({ PATH: "/bin", GLADE_PORT: "1", GLADE_SERVER_KIND: "desktop", PI_UI_HOST: "x", GLADE_INSTALL_TARGET: "/tmp/G.app", GLADE_DATA_DIR: "/d" });
    expect(env).toMatchObject({ PATH: "/bin", GLADE_INSTALL_TARGET: "/tmp/G.app", GLADE_DATA_DIR: "/d", GIT_TERMINAL_PROMPT: "0" });
    expect(env.GLADE_PORT).toBeUndefined();
    expect(env.GLADE_SERVER_KIND).toBeUndefined();
    expect(env.PI_UI_HOST).toBeUndefined();
  });

  it("throttles pushes but always sends the last one", async () => {
    const sent: string[] = [];
    const push = throttle((s) => sent.push(s.state), 20);
    const s = (state: UpdateJobStatus["state"]) => ({ state }) as UpdateJobStatus;
    push(s("checking"));
    push(s("running"));
    push(s("installed"));
    expect(sent).toEqual(["checking"]);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual(["checking", "installed"]);
  });
});

describe("update API", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  function start(job?: UpdateJob) {
    const dir = mkdtempSync(join(tmpdir(), "glade-update-"));
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({
      store,
      harnesses: new HarnessRegistry([new FakeHarness()]),
      scratchDir: join(dir, "scratch"),
      environment: { platform: "darwin", hostname: "studio.local", home: "/Users/test", machineName: () => "Mac", build: () => BUILD },
    });
    const { app } = createApp({ service, updateJob: job });
    cleanups.push(async () => {
      await service.dispose();
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    });
    return (path: string, method = "GET") => app.request(path, { method, headers: { host: "127.0.0.1:4317" } });
  }

  it("a server without a job (pnpm dev) reports it unavailable and refuses to start", async () => {
    const call = start();
    expect(await (await call("/api/version/update")).json()).toMatchObject({ available: false, state: "idle", steps: [{ id: "pull" }, { id: "install" }, { id: "build" }], log: [] });
    const res = await call("/api/version/update", "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: UPDATE_UNAVAILABLE_DEV });
  });

  it("starts, reports and cancels", async () => {
    const { job, commands } = makeJob({ hold: ["git pull --ff-only"] });
    const call = start(job);
    const started = (await (await call("/api/version/update", "POST")).json()) as UpdateJobStatus;
    expect(started).toMatchObject({ available: true, state: "checking", canCancel: true });
    expect((await call("/api/version/update", "POST")).status).toBe(409);
    await until(() => commands.length === 1);
    expect(((await (await call("/api/version/update")).json()) as UpdateJobStatus).steps[0]!.state).toBe("running");
    expect((await call("/api/version/update/cancel", "POST")).status).toBe(200);
    await job.done;
    expect(((await (await call("/api/version/update")).json()) as UpdateJobStatus).state).toBe("cancelled");
    expect((await call("/api/version/update/cancel", "POST")).status).toBe(409);
  });
});
