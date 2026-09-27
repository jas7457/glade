import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiHarness } from "../src/harness/pi/pi-harness.js";
import { PiRpcProcess } from "../src/harness/pi/rpc-process.js";

describe("PiHarness.deleteSession", () => {
  it("permanently removes the session file and its empty folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "glade-del-"));
    const dir = join(root, "--tmp-project--");
    mkdirSync(dir);
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "{}\n");
    const harness = new PiHarness({
      config: () => ({ piPath: "pi", extraArgs: [], autoCompaction: true, autoRetry: true }),
      utilityCwd: root,
    });
    await harness.deleteSession(file);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    // Deleting again is a no-op.
    await expect(harness.deleteSession(file)).resolves.toBeUndefined();
  });
});

describe("PiRpcProcess.kill", () => {
  it("resolves only after the process has exited", async () => {
    const proc = new PiRpcProcess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: tmpdir() });
    proc.start();
    expect(proc.isAlive).toBe(true);
    await proc.kill();
    expect(proc.isAlive).toBe(false);
    await expect(proc.kill()).resolves.toBeUndefined();
  });
});
