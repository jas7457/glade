/** I-192: which terminals are busy, and what closing / deleting them asks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo } from "@glade/protocol";

vi.mock("./terminal-api", () => ({ listTerminals: vi.fn() }));
vi.mock("@glade/app-core/ui", () => ({ confirm: vi.fn(async () => false) }));
const { listTerminals } = await import("./terminal-api");
const { confirm } = await import("@glade/app-core/ui");
const { busyPrograms, busyTerminalPrograms, confirmCloseTerminal, terminateQuestion, terminatingNote } = await import("./close-confirm");

const info = (id: string, foreground: string | null, exit: TerminalInfo["exit"] = null): TerminalInfo => ({
  id,
  workspaceId: "w",
  cwd: "/repo",
  shell: "/bin/zsh",
  pid: 1,
  cols: 80,
  rows: 24,
  startedAt: 1,
  exit,
  foreground,
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("busy terminals", () => {
  it("lists the programs of running shells, optionally only some ids", () => {
    const infos = [info("a", "npm run dev"), info("b", null), info("c", "vim"), info("d", "sleep 1", { code: 0, signal: null })];
    expect(busyPrograms(infos)).toEqual(["npm run dev", "vim"]);
    expect(busyPrograms(infos, ["b", "c"])).toEqual(["vim"]);
    expect(busyPrograms([{ ...info("e", null), foreground: undefined }])).toEqual([]);
  });

  it("asks the server; an error or a slow answer counts as idle", async () => {
    vi.mocked(listTerminals).mockResolvedValueOnce([info("a", "npm run dev")]);
    expect(await busyTerminalPrograms("w", ["a"])).toEqual(["npm run dev"]);
    vi.mocked(listTerminals).mockRejectedValueOnce(new Error("offline"));
    expect(await busyTerminalPrograms("w")).toEqual([]);
    vi.useFakeTimers();
    vi.mocked(listTerminals).mockReturnValueOnce(new Promise(() => {}));
    const slow = busyTerminalPrograms("w");
    await vi.advanceTimersByTimeAsync(3500);
    expect(await slow).toEqual([]);
  });

  it("confirms only a busy close, with the program's name", async () => {
    vi.mocked(listTerminals).mockResolvedValueOnce([info("a", null)]);
    expect(await confirmCloseTerminal("w", "a")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    vi.mocked(listTerminals).mockResolvedValueOnce([info("a", "npm run dev")]);
    expect(await confirmCloseTerminal("w", "a")).toBe(false); // the mock says Cancel
    expect(confirm).toHaveBeenCalledWith({
      title: "Terminate “npm run dev”?",
      message: "It's still running in this terminal. Closing the tab ends it.",
      confirmLabel: "Terminate",
      destructive: true,
    });
  });

  it("shortens long commands and words the delete-chat note", () => {
    expect(terminateQuestion("x".repeat(100)).title).toBe(`Terminate “${"x".repeat(59)}…”?`);
    expect(terminatingNote([])).toBe("");
    expect(terminatingNote(["npm run dev"])).toBe("“npm run dev” in its terminal will be terminated.");
    expect(terminatingNote(["a", "b"])).toBe("“a” and “b” in its terminals will be terminated.");
    expect(terminatingNote(["a", "b", "c", "d"])).toBe("“a”, “b” and 2 more in its terminals will be terminated.");
  });
});
