/**
 * I-154: Settings → General's Update Now (I-160) (the Mac app): the button when behind, the steps while it
 * runs, Cancel, the reason when refused, the log tail when it failed, and restarting (at once when
 * idle; asked when chats are working: when they finish / now). Also the restart decision helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { signal } from "@preact/signals";
import { UPDATE_STEPS, type SessionSummary, type UpdateJobStatus, type UpdateStepState, type VersionStatus } from "@glade/protocol";

const server = vi.hoisted(() => ({ version: null as unknown, job: null as unknown, afterStart: null as unknown, calls: [] as string[] }));
const shell = vi.hoisted(() => ({ relaunch: vi.fn(async (_route: string) => {}) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    request: vi.fn(async (method: string, path: string) => {
      server.calls.push(`${method} ${path}`);
      if (path === "/version/update" && method === "POST") server.job = server.afterStart ?? server.job;
      if (path.startsWith("/version/update")) return server.job;
      return server.version;
    }),
  };
});
vi.mock("@/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop")>();
  return { ...actual, isDesktop: () => true, relaunchApp: shell.relaunch };
});

import { TooltipProvider } from "@/ui";
import { sessions } from "@/state/store";
import { versionStatus } from "@/state/version";
import { busyLocalChats, cancelRestartWait, restartChoice, restartWaiting, restartWhenIdle, updateJob, whenIdle } from "@/state/update";
import { VersionSettings } from "./VersionSettings";

const at = "2026-09-27T12:00:00.000Z";
const VERSION: VersionStatus = {
  build: { commit: "1".repeat(40), shortCommit: "1111111", builtAt: at, dirty: false, repoPath: "/src/glade", kind: "release" },
  check: { state: "behind", behind: 3, checkedAt: at },
  checking: false,
};

function job(state: UpdateJobStatus["state"], steps: UpdateStepState[] = ["pending", "pending", "pending"], extra: Partial<UpdateJobStatus> = {}): UpdateJobStatus {
  return {
    available: true,
    state,
    steps: UPDATE_STEPS.map((s, i) => ({ ...s, state: steps[i]! })),
    log: [],
    canCancel: state === "checking" || (state === "running" && steps[2] !== "running"),
    ...extra,
  };
}

function session(id: string, status: SessionSummary["status"], extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, workspaceId: `w-${id}`, status, running: status === "working", pendingInputs: 0, ...extra } as SessionSummary;
}

function renderAbout() {
  return render(
    <TooltipProvider>
      <VersionSettings />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  versionStatus.value = null;
  updateJob.value = null;
  sessions.value = [];
  cancelRestartWait();
  server.version = VERSION;
  server.afterStart = null;
  server.calls = [];
  shell.relaunch.mockClear();
});
afterEach(cleanup);

describe("Update Now", () => {
  it("offers Update Now when behind and starts the job", async () => {
    server.job = job("idle");
    server.afterStart = job("running", ["running", "pending", "pending"], { log: ["$ git pull --ff-only"] });
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    await waitFor(() => expect(screen.getByTestId("update-steps")).toBeTruthy());
    expect(server.calls).toContain("POST /version/update");
    expect(screen.queryByTestId("update-command")).toBeNull();
    const lines = screen.getByTestId("update-steps").querySelectorAll("li");
    expect([...lines].map((l) => l.getAttribute("data-state"))).toEqual(["running", "pending", "pending"]);
    expect(lines[0]!.textContent).toContain("git pull --ff-only");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("has no Update Now when up to date", async () => {
    server.version = { ...VERSION, check: { state: "up-to-date", checkedAt: at } };
    server.job = job("idle");
    renderAbout();
    await waitFor(() => expect(screen.getByTestId("version-status").textContent).toBe("Up to date"));
    // The status row says it; no second "up to date" line and no copyable command (I-160).
    expect(screen.queryByText("Glade is up to date.")).toBeNull();
    expect(screen.queryByTestId("update-command")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update Now" })).toBeNull();
  });

  it("can't cancel while the new version is built and installed", async () => {
    server.job = job("running", ["done", "done", "running"]);
    renderAbout();
    await waitFor(() => expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("Cancel asks the server", async () => {
    server.job = job("running", ["done", "running", "pending"]);
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(server.calls).toContain("POST /version/update/cancel"));
  });

  it("says why it refused", async () => {
    server.job = job("refused", undefined, { error: "The repo has uncommitted changes (2 files). Commit or stash them, then try again." });
    renderAbout();
    expect((await screen.findByTestId("update-error")).textContent).toBe("Can't update: The repo has uncommitted changes (2 files). Commit or stash them, then try again.");
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
    expect(screen.queryByTestId("update-steps")).toBeNull();
  });

  it("shows the error and the log tail when a step failed", async () => {
    server.job = job("failed", ["done", "done", "failed"], { error: "Build and install Glade failed (`pnpm tauri:install` exited with 101).", log: ["$ pnpm tauri:install", "error[E0425]: oops"] });
    renderAbout();
    expect((await screen.findByTestId("update-error")).textContent).toContain("exited with 101");
    expect(screen.getByTestId("update-log").textContent).toContain("error[E0425]: oops");
  });

  it("follows pushed updates", async () => {
    server.job = job("running", ["running", "pending", "pending"]);
    renderAbout();
    await screen.findByTestId("update-steps");
    updateJob.value = job("running", ["done", "running", "pending"]);
    await waitFor(() => expect(screen.getByTestId("update-steps").querySelectorAll("li")[1]!.getAttribute("data-state")).toBe("running"));
  });

  it("shows the command instead on a server without Update Now", async () => {
    server.job = { ...job("idle"), available: false, unavailableReason: "Only the Glade app updates itself." };
    renderAbout();
    await screen.findByTestId("update-command");
    expect(screen.queryByRole("button", { name: "Update Now" })).toBeNull();
  });
});

describe("Restart Glade to finish", () => {
  it("restarts at once when no chat is working, at the current route", async () => {
    server.job = job("installed", ["done", "done", "done"]);
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Restart Glade" }));
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledWith(window.location.pathname + window.location.search));
  });

  it("asks when chats are working: Restart Now", async () => {
    server.job = job("installed", ["done", "done", "done"]);
    sessions.value = [session("a", "working"), session("b", "blocked"), session("c", "idle")];
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Restart Glade" }));
    expect(screen.getByText("2 chats are still working.")).toBeTruthy();
    expect(shell.relaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
  });

  it("asks when chats are working: Restart When Chats Finish waits for idle", async () => {
    server.job = job("installed", ["done", "done", "done"]);
    sessions.value = [session("a", "working")];
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Restart Glade" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart When Chats Finish" }));
    await screen.findByText("Restarting when chats finish…");
    expect(screen.getByText("1 chat still working.")).toBeTruthy();
    expect(shell.relaunch).not.toHaveBeenCalled();
    sessions.value = [session("a", "idle")];
    await waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
  });

  it("Don't Wait stops waiting", async () => {
    server.job = job("installed", ["done", "done", "done"]);
    sessions.value = [session("a", "working")];
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Restart Glade" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart When Chats Finish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don't Wait" }));
    sessions.value = [];
    await new Promise((r) => setTimeout(r, 10));
    expect(shell.relaunch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart Glade" })).toBeTruthy();
  });
});

describe("restart decision", () => {
  it("restarts when idle, asks when busy", () => {
    expect(restartChoice(0)).toBe("restart");
    expect(restartChoice(2)).toBe("ask");
  });

  it("counts chats this server runs (not other servers' or environments')", () => {
    const list = [
      session("a", "working"),
      session("a2", "blocked", { workspaceId: "w-a" }),
      session("b", "working", { activeElsewhere: { serverKind: "dev" } as SessionSummary["activeElsewhere"] }),
      session("c", "working", { environmentId: "ENV-OTHER" }),
      session("d", "idle"),
      session("e", "error" as SessionSummary["status"]),
    ];
    expect(busyLocalChats(list, (id) => !id)).toBe(1);
  });

  it("whenIdle fires once idle (at once if it already is)", async () => {
    const busy = signal(2);
    const fired = vi.fn();
    whenIdle(busy, fired);
    busy.value = 1;
    await Promise.resolve();
    expect(fired).not.toHaveBeenCalled();
    busy.value = 0;
    await Promise.resolve();
    busy.value = 1;
    busy.value = 0;
    await Promise.resolve();
    expect(fired).toHaveBeenCalledTimes(1);

    const now = vi.fn();
    whenIdle(signal(0), now);
    await Promise.resolve();
    expect(now).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const busy2 = signal(1);
    const stop = whenIdle(busy2, cancelled);
    stop();
    busy2.value = 0;
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("restartWhenIdle relaunches once the chats finish", async () => {
    const busy = signal(1);
    const relaunch = vi.fn(async () => {});
    restartWhenIdle(busy, relaunch);
    expect(restartWaiting.value).toBe(true);
    await Promise.resolve();
    expect(relaunch).not.toHaveBeenCalled();
    busy.value = 0;
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });
});
