/**
 * Folder browser (I-124): FsBrowseService against a throwaway "home" folder, plus the routes.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FsBrowseEntry, FsBrowseResult } from "@glade/protocol";
import { fsBrowseRoutes } from "../src/http/fs-browse.js";
import { compareNames, FsBrowseService, MAX_BROWSE_ENTRIES } from "../src/services/fs-browse.js";

let dir: string;
let home: string;
let outside: string;
let volumes: string;
let service: FsBrowseService;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "glade-browse-")));
  home = join(dir, "home");
  outside = join(dir, "outside");
  volumes = join(dir, "Volumes");
  for (const d of [home, outside, volumes, join(volumes, "Disk"), join(home, "code", "repo", ".git"), join(home, "Beta"), join(home, "alpha"), join(home, ".hidden")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(home, "file.txt"), "x");
  service = new FsBrowseService({ home, roots: [volumes] });
});
afterEach(() => {
  try {
    chmodSync(join(home, "locked"), 0o755);
  } catch {
    // not created by this test
  }
  rmSync(dir, { recursive: true, force: true });
});

const names = (r: FsBrowseResult) => r.entries.map((e) => e.name);

describe("FsBrowseService.browse", () => {
  it("lists home's folders (no files, no hidden) sorted case-insensitively; parent null at home", async () => {
    for (const input of [undefined, "", "~", " ~ ", home, `${home}/`]) {
      const r = await service.browse(input);
      expect(r.path).toBe(home);
      expect(r.parent).toBeNull();
      expect(names(r)).toEqual(["alpha", "Beta", "code"]);
    }
  });

  it("shows hidden folders when asked", async () => {
    const r = await service.browse("~", { hidden: true });
    expect(names(r)).toEqual([".hidden", "alpha", "Beta", "code"]);
    expect(r.entries[0]).toMatchObject({ hidden: true, isGitRepo: false });
  });

  it("marks git repos and normalizes paths", async () => {
    const code = await service.browse("~/code/./repo/..");
    expect(code.path).toBe(join(home, "code"));
    expect(code.parent).toBe(home);
    expect(code.entries).toEqual([{ name: "repo", path: join(home, "code", "repo"), isGitRepo: true, hidden: false }]);
    const repo = await service.browse(join(home, "code", "repo"));
    expect(repo.isGitRepo).toBe(true);
    expect(names(repo)).toEqual([]);
    expect(names(await service.browse(join(home, "code", "repo"), { hidden: true }))).toEqual([".git"]);
  });

  it("allows /Volumes (parent null at its root) and refuses everything else", async () => {
    const v = await service.browse(volumes);
    expect(v.parent).toBeNull();
    expect(names(v)).toEqual(["Disk"]);
    await expect(service.browse(outside)).rejects.toMatchObject({ status: 403 });
    await expect(service.browse(dir)).rejects.toMatchObject({ status: 403 });
    await expect(service.browse(`${home}/..`)).rejects.toMatchObject({ status: 403 });
    await expect(service.browse("relative/path")).rejects.toMatchObject({ status: 400 });
  });

  it("follows symlinks for the check: links leading outside are refused and hidden from listings", async () => {
    symlinkSync(outside, join(home, "escape"));
    symlinkSync(join(home, "alpha"), join(home, "shortcut"));
    symlinkSync(join(home, "nowhere"), join(home, "dangling"));
    symlinkSync(join(home, "file.txt"), join(home, "filelink"));
    expect(names(await service.browse("~"))).toEqual(["alpha", "Beta", "code", "shortcut"]);
    await expect(service.browse("~/escape")).rejects.toMatchObject({ status: 403 });
    await expect(service.browse("~/escape/deeper")).rejects.toMatchObject({ status: 403 });
    const viaLink = await service.browse("~/shortcut");
    expect(viaLink).toMatchObject({ path: join(home, "shortcut"), parent: home });
    expect(viaLink.error).toBeUndefined();
  });

  it("reports missing or unreadable folders as an empty list with an error", async () => {
    const missing = await service.browse("~/nope");
    expect(missing).toMatchObject({ path: join(home, "nope"), parent: home, entries: [] });
    expect(missing.error).toMatch(/doesn't exist/);
    const file = await service.browse("~/file.txt");
    expect(file.error).toMatch(/isn't a folder/);
    if (process.getuid?.() !== 0) {
      mkdirSync(join(home, "locked"));
      chmodSync(join(home, "locked"), 0o000);
      const locked = await service.browse("~/locked");
      expect(locked.entries).toEqual([]);
      expect(locked.error).toMatch(/permission/);
    }
  });

  it(`caps listings at ${MAX_BROWSE_ENTRIES} entries`, async () => {
    const big = join(home, "big");
    for (let i = 0; i < MAX_BROWSE_ENTRIES + 5; i++) mkdirSync(join(big, `d${i}`), { recursive: true });
    const r = await service.browse(big);
    expect(r.entries).toHaveLength(MAX_BROWSE_ENTRIES);
    expect(r.entries[0]!.name).toBe("d0");
    expect(r.entries[2]!.name).toBe("d2"); // numeric order
  });

  it("compareNames is case-insensitive and number-aware", () => {
    expect(["b", "A", "a10", "a2", "C"].sort(compareNames)).toEqual(["A", "a2", "a10", "b", "C"]);
  });
});

describe("FsBrowseService.mkdir", () => {
  it("creates a folder inside the allowed area", async () => {
    const e = await service.mkdir("~/code/new one");
    expect(e).toEqual({ name: "new one", path: join(home, "code", "new one"), isGitRepo: false, hidden: false });
    expect(existsSync(e.path)).toBe(true);
  });

  it("refuses existing folders, missing parents and paths outside the area", async () => {
    await expect(service.mkdir("~/alpha")).rejects.toMatchObject({ status: 409 });
    await expect(service.mkdir("~/missing/child")).rejects.toMatchObject({ status: 404 });
    await expect(service.mkdir(join(outside, "x"))).rejects.toMatchObject({ status: 403 });
    symlinkSync(outside, join(home, "escape"));
    await expect(service.mkdir("~/escape/x")).rejects.toMatchObject({ status: 403 });
    expect(existsSync(join(outside, "x"))).toBe(false);
  });
});

describe("fs browse routes", () => {
  const app = () => fsBrowseRoutes(new FsBrowseService({ home, roots: [volumes] }));

  it("GET /fs/browse", async () => {
    const res = await app().request("/fs/browse?path=~&hidden=1");
    expect(res.status).toBe(200);
    expect(names((await res.json()) as FsBrowseResult)).toEqual([".hidden", "alpha", "Beta", "code"]);
    const denied = await app().request(`/fs/browse?path=${encodeURIComponent(outside)}`);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/home folder/);
  });

  it("POST /fs/mkdir", async () => {
    const post = (body: unknown) =>
      app().request("/fs/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = await post({ path: "~/made" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as FsBrowseEntry).path).toBe(join(home, "made"));
    expect((await post({ path: "~/made" })).status).toBe(409);
    expect((await post({})).status).toBe(400);
  });
});
