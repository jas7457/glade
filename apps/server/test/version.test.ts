/**
 * I-149: the build stamp (stubbed git), the behind check (stubbed git: up to date, behind N, a
 * commit the local repo doesn't have, offline / auth failure, no repo folder), comparing another
 * build with ours, and the API shape (`GET /api/version`, `POST /api/version/check`,
 * `GET /api/version/compare`, `build` in `GET /api/environment`). No network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildComparison, BuildInfo, EnvironmentInfo, VersionStatus } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import { gitStamp, type GitRunSync } from "../src/services/build-info.js";
import { UpdateChecker, type GitRun } from "../src/services/update-check.js";
import { Store } from "../src/store/store.js";

const A = "a".repeat(40); // the build
const B = "b".repeat(40); // origin's main
const C = "c".repeat(40);
const REPO = "/src/glade";
const NOW = new Date("2026-09-27T12:00:00.000Z");

const BUILD: BuildInfo = { commit: A, shortCommit: "aaaaaaa", builtAt: "2026-09-26T10:00:00.000Z", dirty: false, repoPath: REPO, kind: "release" };

describe("gitStamp", () => {
  const git =
    (answers: Record<string, string | Error>): GitRunSync =>
    (args) => {
      const answer = answers[args.join(" ")];
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`unexpected git ${args.join(" ")}`);
      return answer;
    };
  const base = { "rev-parse HEAD": `${A}\n`, "rev-parse --show-toplevel": `${REPO}\n`, "status --porcelain --untracked-files=no": "" };

  it("stamps a release build with HEAD, the build time and the repo folder", () => {
    expect(gitStamp(REPO, "release", git(base), () => NOW)).toEqual({ ...BUILD, builtAt: NOW.toISOString() });
  });

  it("marks local changes", () => {
    expect(gitStamp(REPO, "release", git({ ...base, "status --porcelain --untracked-files=no": " M src/x.ts\n" }), () => NOW)?.dirty).toBe(true);
  });

  it("uses the HEAD commit's time for a dev server", () => {
    const stamp = gitStamp(REPO, "dev", git({ ...base, [`log -1 --format=%cI ${A}`]: "2026-09-20T08:00:00+02:00\n" }), () => NOW);
    expect(stamp).toMatchObject({ kind: "dev", builtAt: "2026-09-20T06:00:00.000Z" });
  });

  it("is null outside a git checkout", () => {
    expect(gitStamp("/tmp", "release", git({ "rev-parse HEAD": new Error("not a git repository") }))).toBeNull();
  });
});

/** A stubbed git: `ls-remote` answers `remote` (or fails), the local repo has `known` commits and `ancestry` counts. */
function fakeGit({ remote, known = [A], counts = {} }: { remote: string | Error; known?: string[]; counts?: Record<string, number> }) {
  const calls: string[][] = [];
  const git: GitRun = async (args, cwd) => {
    calls.push(args);
    expect(cwd).toBe(REPO);
    const [cmd] = args;
    if (cmd === "ls-remote") {
      if (remote instanceof Error) throw remote;
      return `${remote}\trefs/heads/main\n`;
    }
    if (cmd === "cat-file") {
      const sha = args[2]!.replace("^{commit}", "");
      if (!known.includes(sha)) throw new Error("Not a valid object name");
      return "";
    }
    if (cmd === "rev-list") return `${counts[args[2]!] ?? 0}\n`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { git, calls };
}

function checker(git: GitRun, build: BuildInfo | null = BUILD, exists = (p: string) => p === join(REPO, ".git")) {
  return new UpdateChecker({ build: () => build, git, exists, now: () => NOW });
}

describe("UpdateChecker", () => {
  it("is up to date when origin's main is the build", async () => {
    const { git, calls } = fakeGit({ remote: A });
    const status = await checker(git).check();
    expect(status).toEqual({ build: BUILD, checking: false, check: { state: "up-to-date", remoteCommit: A, checkedAt: NOW.toISOString() } });
    // Read-only: only ls-remote of origin's main.
    expect(calls).toEqual([["ls-remote", "--exit-code", "origin", "refs/heads/main"]]);
  });

  it("counts the commits behind when the local repo has origin's commit", async () => {
    const { git, calls } = fakeGit({ remote: B, known: [A, B], counts: { [`${A}..${B}`]: 12 } });
    const { check } = await checker(git).check();
    expect(check).toMatchObject({ state: "behind", behind: 12, remoteCommit: B });
    for (const args of calls) expect(["ls-remote", "cat-file", "rev-list"]).toContain(args[0]);
  });

  it("says up to date when the build already contains origin's main (unpushed commits)", async () => {
    const { git } = fakeGit({ remote: B, known: [A, B], counts: { [`${A}..${B}`]: 0 } });
    expect((await checker(git).check()).check?.state).toBe("up-to-date");
  });

  it("says update available when the local repo doesn't have origin's commit yet", async () => {
    const { git, calls } = fakeGit({ remote: B, known: [A] });
    const { check } = await checker(git).check();
    expect(check).toEqual({ state: "update-available", remoteCommit: B, checkedAt: NOW.toISOString() });
    expect(calls.some((c) => c[0] === "rev-list")).toBe(false);
  });

  it("couldn't check when ls-remote fails (offline, no credentials)", async () => {
    const { git } = fakeGit({ remote: new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled") });
    const { check } = await checker(git).check();
    expect(check).toMatchObject({ state: "failed", reason: expect.stringContaining("terminal prompts disabled") });
  });

  it("doesn't run git when the build's repo folder isn't on this machine, or there's no stamp", async () => {
    const { git, calls } = fakeGit({ remote: A });
    expect((await checker(git, BUILD, () => false).check()).check).toMatchObject({ state: "unavailable", reason: expect.stringContaining(REPO) });
    expect((await checker(git, null).check()).check?.state).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("joins a check in progress and reports it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const git: GitRun = async () => {
      await gate;
      return `${A}\trefs/heads/main\n`;
    };
    const c = checker(git);
    const first = c.check();
    const second = c.check();
    expect(first).toBe(second);
    expect(c.status().checking).toBe(true);
    release();
    expect((await first).checking).toBe(false);
    expect(c.status().check?.state).toBe("up-to-date");
  });

  it("compares another build with ours", async () => {
    const counts = { [`${A}..${B}`]: 3, [`${B}..${A}`]: 0, [`${A}..${C}`]: 0, [`${C}..${A}`]: 5 };
    const { git } = fakeGit({ remote: A, known: [A, B, C], counts });
    const c = checker(git);
    expect(await c.compare(B)).toEqual({ commit: B, relation: "newer", count: 3 });
    expect(await c.compare(C)).toEqual({ commit: C, relation: "older", count: 5 });
    expect(await c.compare(A.slice(0, 7))).toEqual({ commit: A.slice(0, 7), relation: "same" });
    expect(await c.compare("d".repeat(40))).toEqual({ commit: "d".repeat(40), relation: "unknown" });
    await expect(c.compare("not a sha")).rejects.toThrow();
  });

  it("can't compare without our repo", async () => {
    const { git } = fakeGit({ remote: A, known: [A, B] });
    expect(await checker(git, BUILD, () => false).compare(B)).toEqual({ commit: B, relation: "unknown" });
  });
});

describe("version API", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  function start() {
    const dir = mkdtempSync(join(tmpdir(), "glade-version-"));
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({
      store,
      harnesses: new HarnessRegistry([new FakeHarness()]),
      scratchDir: join(dir, "scratch"),
      environment: { platform: "darwin", hostname: "studio.local", home: "/Users/test", machineName: () => "Mac", build: () => BUILD },
    });
    const { git } = fakeGit({ remote: B, known: [A, B], counts: { [`${A}..${B}`]: 2, [`${B}..${A}`]: 0 } });
    const updates = new UpdateChecker({ build: () => service.environment.build(), git, exists: () => true, now: () => NOW });
    const { app } = createApp({ service, updates });
    cleanups.push(async () => {
      await service.dispose();
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    });
    const get = (path: string, method = "GET") => app.request(path, { method, headers: { host: "127.0.0.1:4317" } });
    return { get };
  }

  it("GET /api/environment includes the build", async () => {
    const { get } = start();
    expect(((await (await get("/api/environment")).json()) as EnvironmentInfo).build).toEqual(BUILD);
  });

  it("GET /api/version answers the last check; POST /api/version/check runs one", async () => {
    const { get } = start();
    expect((await (await get("/api/version")).json()) as VersionStatus).toEqual({ build: BUILD, check: null, checking: false });
    const checked = (await (await get("/api/version/check", "POST")).json()) as VersionStatus;
    expect(checked).toEqual({ build: BUILD, checking: false, check: { state: "behind", behind: 2, remoteCommit: B, checkedAt: NOW.toISOString() } });
    expect(((await (await get("/api/version")).json()) as VersionStatus).check?.state).toBe("behind");
  });

  it("GET /api/version/compare compares a commit with ours", async () => {
    const { get } = start();
    expect((await (await get(`/api/version/compare?commit=${B}`)).json()) as BuildComparison).toEqual({ commit: B, relation: "newer", count: 2 });
    expect((await get("/api/version/compare?commit=nope")).status).toBe(400);
  });
});
