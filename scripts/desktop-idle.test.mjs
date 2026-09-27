// `pnpm tauri:install --when-idle` helpers (apps/desktop/scripts/idle.mjs, I-058).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { busyChats, dataDirs, findServers, formatDuration } from "../apps/desktop/scripts/idle.mjs";

test("busyChats counts working/blocked chats of that server, one per workspace", () => {
  const busy = busyChats([
    { workspaceId: "a", title: "Fix login", status: "working" },
    { workspaceId: "a", title: "Tab 2", status: "blocked" },
    { workspaceId: "b", title: "Idle", status: "idle" },
    { workspaceId: "c", title: "Unread", status: "unread" },
    { workspaceId: "d", title: "In dev", status: "working", activeElsewhere: { serverKind: "dev", since: 1 } },
  ]);
  assert.deepEqual(busy, [{ workspaceId: "a", titles: ["Fix login", "Tab 2"] }]);
});

test("findServers lists live servers of a kind from the registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "glade-idle-"));
  try {
    mkdirSync(join(dir, "servers"));
    writeFileSync(join(dir, "servers", "1.json"), JSON.stringify({ pid: 1, kind: "desktop", host: "127.0.0.1", port: 5 }));
    writeFileSync(join(dir, "servers", "2.json"), JSON.stringify({ pid: 2, kind: "dev", host: "127.0.0.1", port: 6 }));
    writeFileSync(join(dir, "servers", "3.json"), JSON.stringify({ pid: 3, kind: "desktop", host: "127.0.0.1", port: 7 }));
    writeFileSync(join(dir, "servers", "bad.json"), "{");
    const alive = (pid) => pid !== 3;
    assert.deepEqual(findServers(dir, "desktop", alive).map((s) => s.port), [5]);
    assert.deepEqual(findServers(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dataDirs also searches the pre-rename pi-ui folder unless a data folder is set (I-059)", () => {
  assert.deepEqual(dataDirs({}, "/Users/me"), [
    "/Users/me/Library/Application Support/Glade",
    "/Users/me/Library/Application Support/pi-ui",
  ]);
  assert.deepEqual(dataDirs({ GLADE_DATA_DIR: "/tmp/g" }, "/Users/me"), ["/tmp/g"]);
  assert.deepEqual(dataDirs({ PI_UI_DATA_DIR: "/tmp/p" }, "/Users/me"), ["/tmp/p"]);
});

test("findServers merges several folders (old + new app), each server once", () => {
  const root = mkdtempSync(join(tmpdir(), "glade-idle-dirs-"));
  try {
    for (const [dir, pid, port] of [["Glade", 1, 5], ["pi-ui", 2, 6], ["pi-ui", 1, 5]]) {
      mkdirSync(join(root, dir, "servers"), { recursive: true });
      writeFileSync(join(root, dir, "servers", `${pid}.json`), JSON.stringify({ pid, kind: "desktop", host: "127.0.0.1", port }));
    }
    const found = findServers([join(root, "Glade"), join(root, "pi-ui")], "desktop", () => true);
    assert.deepEqual(found.map((s) => s.port).sort(), [5, 6]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatDuration", () => {
  assert.equal(formatDuration(5_400), "5s");
  assert.equal(formatDuration(83_000), "1m23s");
});
