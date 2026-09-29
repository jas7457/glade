/** I-149: Settings → About (build line, each check state, Check Now, the update command) and the Settings dots. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { BuildInfo, VersionStatus } from "@glade/protocol";

const server = vi.hoisted(() => ({ status: null as unknown, afterCheck: null as unknown, calls: [] as string[] }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    request: vi.fn(async (method: string, path: string) => {
      server.calls.push(`${method} ${path}`);
      if (method === "POST" && path === "/version/check") server.status = server.afterCheck ?? server.status;
      return server.status;
    }),
  };
});

import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@/ui";
import { SettingsNav } from "./SettingsNav";
import { versionStatus } from "@/state/version";
import { AboutSettings } from "./AboutSettings";

const BUILD: BuildInfo = { commit: "1f00e8a".padEnd(40, "0"), shortCommit: "1f00e8a", builtAt: "2026-09-27T10:00:00.000Z", dirty: true, repoPath: "/src/glade", kind: "release" };
const at = "2026-09-27T12:00:00.000Z";
const status = (check: VersionStatus["check"]): VersionStatus => ({ build: BUILD, check, checking: false });

function renderAbout() {
  return render(
    <TooltipProvider>
      <AboutSettings />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  versionStatus.value = null;
  server.calls = [];
  server.afterCheck = null;
});
afterEach(cleanup);

describe("About", () => {
  it("shows the build, local changes, the update command and the quit hint", async () => {
    server.status = status({ state: "up-to-date", checkedAt: at });
    renderAbout();
    await waitFor(() => expect(screen.getByTestId("build-line").textContent).toMatch(/^Built from 1f00e8a on /));
    expect(screen.getByText(/With local changes/)).toBeTruthy();
    expect(screen.getByTestId("version-status").textContent).toBe("Up to date");
    expect(screen.getByTestId("update-command").textContent).toBe("git pull && pnpm install && pnpm tauri:install");
    expect(screen.getByText(/quit Glade completely \(from the menu bar: Quit Glade Completely\)/)).toBeTruthy();
  });

  it.each<[VersionStatus["check"], string]>([
    [{ state: "behind", behind: 4, checkedAt: at }, "4 commits behind main"],
    [{ state: "update-available", checkedAt: at }, "Update available"],
    [{ state: "failed", reason: "Could not resolve host: github.com", checkedAt: at }, "Couldn't check"],
  ])("shows %o as %s", async (check, text) => {
    server.status = status(check);
    renderAbout();
    await waitFor(() => expect(screen.getByTestId("version-status").textContent).toBe(text));
    if (check?.state === "failed") expect(screen.getByText("Could not resolve host: github.com")).toBeTruthy();
  });

  it("Check Now asks the server to check", async () => {
    server.status = status({ state: "failed", reason: "offline", checkedAt: at });
    server.afterCheck = status({ state: "behind", behind: 2, checkedAt: at });
    renderAbout();
    await waitFor(() => expect(screen.getByTestId("version-status").textContent).toBe("Couldn't check"));
    fireEvent.click(screen.getByRole("button", { name: "Check Now" }));
    await waitFor(() => expect(screen.getByTestId("version-status").textContent).toBe("2 commits behind main"));
    expect(server.calls).toContain("POST /version/check");
  });

  it("copies the update command", async () => {
    server.status = status({ state: "behind", behind: 1, checkedAt: at });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("git pull && pnpm install && pnpm tauri:install"));
    vi.unstubAllGlobals();
  });
});

describe("Settings nav dot", () => {
  it("marks About only when a newer Glade is on main", () => {
    versionStatus.value = status({ state: "up-to-date", checkedAt: at });
    const { rerender } = render(
      <MemoryRouter>
        <SettingsNav />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("Update available")).toBeNull();
    versionStatus.value = status({ state: "behind", behind: 3, checkedAt: at });
    rerender(
      <MemoryRouter>
        <SettingsNav />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Update available").closest("button")!.textContent).toContain("About");
  });
});
