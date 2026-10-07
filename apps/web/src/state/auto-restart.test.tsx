/**
 * I-197: restarting into a newly installed version on its own: right away when no chat is working,
 * else once they all finish (with the app-wide notice: Restart Now / Cancel); once per installed
 * build (Cancel sticks until a newer one); never before the chat list is known, for dev servers
 * or outside the Mac app; Update Now reaching `installed` re-reads the version status. Also the
 * Settings row while restarting and composer drafts kept across the restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { signal } from "@preact/signals";
import { UPDATE_STEPS, type BuildInfo, type ServerMessage, type SessionSummary, type UpdateJobStatus, type VersionStatus } from "@glade/protocol";

const server = vi.hoisted(() => ({ version: null as unknown, job: null as unknown, calls: [] as string[] }));
const shell = vi.hoisted(() => ({ relaunch: vi.fn(async (_route: string) => {}) }));
vi.mock("@glade/app-core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/api")>();
  return {
    ...actual,
    request: vi.fn(async (method: string, path: string) => {
      server.calls.push(`${method} ${path}`);
      if (path.startsWith("/version/update")) return server.job;
      return server.version;
    }),
  };
});
vi.mock("@glade/app-core/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/desktop")>();
  return { ...actual, isDesktop: () => true, relaunchApp: shell.relaunch };
});

import type { Socket } from "@glade/app-core/lib/socket";
import { TooltipProvider } from "@glade/app-core/ui";
import { drafts, RESTART_DRAFTS_KEY, restoreDraftsAfterRestart } from "@glade/app-core/features/chat/drafts";
import { sessions } from "@glade/app-core/state/store";
import { versionStatus } from "@glade/app-core/state/version";
import { RestartNotice } from "@/app/RestartNotice";
import { VersionSettings } from "@/features/settings/VersionSettings";
import { autoRestartFor, installedBuild, resetAutoRestart, restarting, restartWaiting, startAutoRestart, updateJob } from "./update";

const RUNNING: BuildInfo = { commit: "1".repeat(40), shortCommit: "1111111", builtAt: "2026-10-05T10:00:00.000Z", dirty: false, repoPath: "/src/glade", kind: "release" };
const NEW: BuildInfo = { ...RUNNING, commit: "2".repeat(40), shortCommit: "2222222", builtAt: "2026-10-05T11:00:00.000Z" };
const NEWER: BuildInfo = { ...RUNNING, commit: "3".repeat(40), shortCommit: "3333333", builtAt: "2026-10-05T12:00:00.000Z" };

const status = (installed?: BuildInfo, build: BuildInfo = RUNNING): VersionStatus => ({ build, check: null, checking: false, ...(installed ? { installed } : {}) });

function session(id: string, status: SessionSummary["status"]): SessionSummary {
  return { id, workspaceId: `w-${id}`, status, running: status === "working", pendingInputs: 0 } as SessionSummary;
}

function fakeSocket() {
  const handlers = new Set<(m: ServerMessage) => void>();
  const socket = {
    onMessage(h: (m: ServerMessage) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  } as unknown as Socket;
  return { socket, push: (m: ServerMessage) => handlers.forEach((h) => h(m)) };
}

const stops: Array<() => void> = [];
function start(options: Parameters<typeof startAutoRestart>[0] = {}) {
  const { socket, push } = fakeSocket();
  const ready = signal(true);
  stops.push(startAutoRestart({ socket, ready, ...options }));
  return { push, ready };
}

beforeEach(() => {
  versionStatus.value = status();
  updateJob.value = null;
  sessions.value = [];
  resetAutoRestart();
  server.version = status();
  server.job = null;
  server.calls = [];
  shell.relaunch.mockClear();
  drafts.clear();
  localStorage.clear();
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  cleanup();
});

describe("restarting on its own", () => {
  it("restarts right away when no chat is working", async () => {
    start();
    expect(shell.relaunch).not.toHaveBeenCalled();
    versionStatus.value = status(NEW);
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
    expect(restarting.value).toBe(true);
  });

  it("waits while chats work and restarts once they all finish", async () => {
    sessions.value = [session("a", "working"), session("b", "blocked")];
    start();
    versionStatus.value = status(NEW);
    expect(restartWaiting.value).toBe(true);
    sessions.value = [session("a", "idle"), session("b", "blocked")];
    await Promise.resolve();
    expect(shell.relaunch).not.toHaveBeenCalled();
    sessions.value = [session("a", "idle"), session("b", "idle")];
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
  });

  it("Cancel stops it for that build; a newer build starts it again", async () => {
    sessions.value = [session("a", "working")];
    start();
    versionStatus.value = status(NEW);
    render(<RestartNotice />);
    expect(screen.getByText("Glade restarts when 1 chat finishes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(restartWaiting.value).toBe(false);
    expect(screen.queryByTestId("restart-notice")).toBeNull();
    // The same build pushed again (a check finished): no new wait.
    versionStatus.value = { ...status(NEW), checking: true };
    sessions.value = [];
    await new Promise((r) => setTimeout(r, 10));
    expect(shell.relaunch).not.toHaveBeenCalled();
    expect(restartWaiting.value).toBe(false);
    // A newer build was installed: restart (nothing works any more).
    versionStatus.value = status(NEWER);
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
  });

  it("the notice's Restart Now restarts at once", async () => {
    sessions.value = [session("a", "working"), session("b", "working")];
    start();
    versionStatus.value = status(NEW);
    render(<RestartNotice />);
    expect(screen.getByText("Glade restarts when 2 chats finish.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Restarting Glade…")).toBeTruthy();
  });

  it("decides only once the chat list is loaded (an empty list isn't \"no chat is working\")", async () => {
    const ready = signal(false);
    start({ ready });
    versionStatus.value = status(NEW);
    await new Promise((r) => setTimeout(r, 10));
    expect(shell.relaunch).not.toHaveBeenCalled();
    expect(restartWaiting.value).toBe(false);
    sessions.value = [session("a", "working")];
    ready.value = true;
    expect(restartWaiting.value).toBe(true);
    expect(shell.relaunch).not.toHaveBeenCalled();
  });

  it("never outside the Mac app, and never for a dev server", async () => {
    start({ enabled: () => false });
    versionStatus.value = status(NEW);
    await new Promise((r) => setTimeout(r, 10));
    expect(shell.relaunch).not.toHaveBeenCalled();
    expect(installedBuild(status(NEW, { ...RUNNING, kind: "dev" }))).toBeNull();
    expect(installedBuild(status(NEW))).toEqual(NEW);
    expect(installedBuild(null)).toBeNull();
  });

  it("Update Now reaching `installed` re-reads the version status", async () => {
    const { push } = start();
    server.version = status(NEW);
    const job: UpdateJobStatus = { available: true, state: "installed", steps: UPDATE_STEPS.map((s) => ({ ...s, state: "done" })), log: [], canCancel: false };
    push({ type: "batch", messages: [{ type: "update", update: job }] });
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
    expect(server.calls).toContain("GET /version");
  });

  it("decides once per build", () => {
    const busy = signal(1);
    expect(autoRestartFor(NEW, busy)).toBe("wait");
    expect(autoRestartFor(NEW, busy)).toBe("none");
  });
});

describe("Settings while restarting", () => {
  const installedJob: UpdateJobStatus = { available: true, state: "installed", steps: UPDATE_STEPS.map((s) => ({ ...s, state: "done" })), log: [], canCancel: false };

  function renderSettings() {
    return render(
      <TooltipProvider>
        <VersionSettings />
      </TooltipProvider>,
    );
  }

  it("says Restarting… instead of offering the button", async () => {
    server.job = installedJob;
    server.version = status(NEW);
    start();
    renderSettings();
    expect(await screen.findByText("Restarting…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart Glade" })).toBeNull();
  });

  it("shows the wait with Cancel / Restart Now, and the button again after Cancel", async () => {
    server.job = installedJob;
    server.version = status(NEW);
    sessions.value = [session("a", "working")];
    start();
    renderSettings();
    expect(await screen.findByText("Restarting when chats finish…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Restart Glade" })).toBeTruthy();
  });

  it("offers the restart for a build installed another way (pnpm tauri:install)", async () => {
    server.job = { ...installedJob, state: "idle", steps: UPDATE_STEPS.map((s) => ({ ...s, state: "pending" })) };
    server.version = status(NEW);
    sessions.value = [session("a", "working")];
    renderSettings();
    expect(await screen.findByRole("button", { name: "Restart Glade" })).toBeTruthy();
  });
});

describe("composer drafts across the restart", () => {
  it("saves them before relaunching and takes them back once on the next launch", async () => {
    drafts.set("chat:s1", "half a thought");
    drafts.set("new:p1", "a new chat");
    start();
    versionStatus.value = status(NEW);
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(RESTART_DRAFTS_KEY)).toBeTruthy();
    drafts.clear(); // the next launch
    restoreDraftsAfterRestart();
    expect([...drafts]).toEqual([
      ["chat:s1", "half a thought"],
      ["new:p1", "a new chat"],
    ]);
    expect(localStorage.getItem(RESTART_DRAFTS_KEY)).toBeNull();
  });

  it("drops saved drafts from a restart long ago", () => {
    localStorage.setItem(RESTART_DRAFTS_KEY, JSON.stringify({ savedAt: Date.now() - 60 * 60 * 1000, drafts: [["chat:s1", "old"]] }));
    restoreDraftsAfterRestart();
    expect(drafts.size).toBe(0);
    expect(localStorage.getItem(RESTART_DRAFTS_KEY)).toBeNull();
  });
});
