/** I-197: composer drafts kept across a restart into a new version (saved before, taken back once after). */
import { beforeEach, describe, expect, it } from "vitest";
import { drafts, RESTART_DRAFTS_KEY, RESTORE_WITHIN_MS, restoreDraftsAfterRestart, saveDraftsForRestart } from "./drafts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

beforeEach(() => drafts.clear());

describe("drafts across a restart", () => {
  it("saves the drafts and restores them once", () => {
    const storage = memoryStorage();
    drafts.set("chat:a", "hello");
    drafts.set("new:p", "draft for a new chat");
    saveDraftsForRestart(storage, 1000);
    drafts.clear();
    restoreDraftsAfterRestart(storage, 2000);
    expect(Object.fromEntries(drafts)).toEqual({ "chat:a": "hello", "new:p": "draft for a new chat" });
    expect(storage.items.has(RESTART_DRAFTS_KEY)).toBe(false);
    drafts.clear();
    restoreDraftsAfterRestart(storage, 3000);
    expect(drafts.size).toBe(0);
  });

  it("keeps what was typed since over a saved draft, and clears the saved copy when there are no drafts", () => {
    const storage = memoryStorage();
    drafts.set("chat:a", "old");
    saveDraftsForRestart(storage, 0);
    drafts.set("chat:a", "newer");
    restoreDraftsAfterRestart(storage, 1);
    expect(drafts.get("chat:a")).toBe("newer");
    drafts.clear();
    storage.setItem(RESTART_DRAFTS_KEY, "x");
    saveDraftsForRestart(storage, 0);
    expect(storage.items.has(RESTART_DRAFTS_KEY)).toBe(false);
  });

  it("ignores stale or broken saved drafts", () => {
    const storage = memoryStorage();
    drafts.set("chat:a", "x");
    saveDraftsForRestart(storage, 0);
    drafts.clear();
    restoreDraftsAfterRestart(storage, RESTORE_WITHIN_MS + 1);
    expect(drafts.size).toBe(0);
    storage.setItem(RESTART_DRAFTS_KEY, "{not json");
    restoreDraftsAfterRestart(storage, 0);
    storage.setItem(RESTART_DRAFTS_KEY, JSON.stringify({ savedAt: 0, drafts: [["k", 1], "bad", ["ok", "yes"]] }));
    restoreDraftsAfterRestart(storage, 0);
    expect(Object.fromEntries(drafts)).toEqual({ ok: "yes" });
  });
});
