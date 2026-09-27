// `pnpm tauri:install --when-idle` helpers (apps/desktop/scripts/idle.mjs, I-058).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { busyChats, findServers, formatDuration } from "../apps/desktop/scripts/idle.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-idle-"));
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

test("formatDuration", () => {
  assert.equal(formatDuration(5_400), "5s");
  assert.equal(formatDuration(83_000), "1m23s");
});
