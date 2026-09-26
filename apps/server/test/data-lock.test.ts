/**
 * I-022: the data-dir lock (acquire / refuse / stale / release).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataLock, DataDirInUseError, LOCK_FILE, readLock, type LockInfo } from "../src/services/data-lock.js";

const dirs: string[] = [];
const servers: Server[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-lock-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const base = { kind: "dev", host: "127.0.0.1", port: 4317 };
const alive = () => true;
const dead = () => false;
const answers = async () => true;
const silent = async () => false;

function writeHolder(dir: string, holder: Partial<LockInfo> = {}): LockInfo {
  const info: LockInfo = { pid: 999_999, port: 5000, host: "127.0.0.1", kind: "desktop", startedAt: 1, ...holder };
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify(info));
  return info;
}

describe("data-dir lock", () => {
  it("acquires, records the port after listen, releases", async () => {
    const dir = tempDir();
    const lock = await acquireDataLock(dir, { ...base, pid: 42 });
    expect(readLock(lock.path)).toMatchObject({ pid: 42, port: 4317, host: "127.0.0.1", kind: "dev" });
    lock.update({ port: 4400 });
    expect(readLock(lock.path)?.port).toBe(4400);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    lock.release(); // idempotent
  });

  it("creates the data dir if needed", async () => {
    const dir = join(tempDir(), "nested", "data");
    const lock = await acquireDataLock(dir, { ...base, pid: 1 });
    expect(existsSync(lock.path)).toBe(true);
  });

  it("refuses when a live server holds it", async () => {
    const dir = tempDir();
    const holder = writeHolder(dir);
    const err = await acquireDataLock(dir, { ...base, pid: 1, isAlive: alive, probe: answers }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataDirInUseError);
    expect((err as DataDirInUseError).holder).toEqual(holder);
    expect((err as Error).message).toBe(
      "The pi-ui data folder is in use by the desktop server on http://127.0.0.1:5000 (pid 999999). Quit it first — or open that URL.",
    );
    expect(readLock(join(dir, LOCK_FILE))).toEqual(holder); // untouched
  });

  it("replaces a lock whose pid is dead", async () => {
    const dir = tempDir();
    writeHolder(dir);
    let probed = false;
    const lock = await acquireDataLock(dir, { ...base, pid: 7, isAlive: dead, probe: async () => (probed = true) });
    expect(probed).toBe(false);
    expect(readLock(lock.path)?.pid).toBe(7);
  });

  it("replaces a lock whose server doesn't answer (e.g. pid reused)", async () => {
    const dir = tempDir();
    writeHolder(dir);
    const lock = await acquireDataLock(dir, { ...base, pid: 7, isAlive: alive, probe: silent });
    expect(readLock(lock.path)?.pid).toBe(7);
  });

  it("replaces unreadable locks and locks left by the same pid", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), "{garbage");
    const a = await acquireDataLock(dir, { ...base, pid: 7, isAlive: alive, probe: answers });
    expect(readLock(a.path)?.pid).toBe(7);
    const b = await acquireDataLock(dir, { ...base, pid: 7, isAlive: alive, probe: answers });
    expect(readLock(b.path)?.startedAt).toBeGreaterThanOrEqual(a.info.startedAt);
  });

  it("release doesn't remove a lock someone else took over", async () => {
    const dir = tempDir();
    const mine = await acquireDataLock(dir, { ...base, pid: 7 });
    const theirs = writeHolder(dir, { pid: 8 });
    mine.update({ port: 1 }); // no-op: not ours any more
    mine.release();
    expect(readLock(join(dir, LOCK_FILE))).toEqual(theirs);
  });

  it("uses the real pid check and HTTP probe by default", async () => {
    const dir = tempDir();
    // A live process (this one) with a server answering /api/settings → refuse.
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/api/settings" ? 200 : 404).end("{}");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    writeHolder(dir, { pid: process.pid, port });
    await expect(acquireDataLock(dir, { ...base, pid: 1 })).rejects.toBeInstanceOf(DataDirInUseError);

    // Same live pid but nothing on the port → stale.
    await new Promise((r) => server.close(r));
    servers.length = 0;
    const lock = await acquireDataLock(dir, { ...base, pid: 1 });
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(1);
  });
});
