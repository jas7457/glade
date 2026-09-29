/** I-147/I-150: keep-awake setting + status in General, the Mac app's own options. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { defaultSettings } from "@glade/protocol";

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn() },
  request: vi.fn(),
}));
vi.mock("@/lib/desktop", () => ({
  isDesktop: () => true,
  getDesktopPrefs: vi.fn(),
  setDesktopPrefs: vi.fn(),
  getLoginItem: vi.fn(),
  setLoginItem: vi.fn(),
}));

import { api, request } from "@/lib/api";
import * as desktop from "@/lib/desktop";
import { settings } from "@/state/store";
import { powerStatus } from "@/state/power";
import { DesktopAppSettings, KeepAwakeSettings } from "./DesktopAppSettings";

const prefs = { showInDock: true, quitToMenuBar: true, quitNoticeShown: false };

describe("Settings → General (Mac)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value = defaultSettings();
    powerStatus.value = null;
    vi.mocked(api.updateSettings).mockImplementation(async () => settings.value);
    vi.mocked(request).mockResolvedValue({ reasons: [{ kind: "working", chats: 1 }], text: "a chat is working", held: true, canHold: true, powerSource: null, sharedSkipped: null });
    vi.mocked(desktop.getDesktopPrefs).mockResolvedValue(prefs);
    vi.mocked(desktop.setDesktopPrefs).mockImplementation(async (patch) => ({ ...prefs, ...patch }));
    vi.mocked(desktop.getLoginItem).mockResolvedValue("disabled");
    vi.mocked(desktop.setLoginItem).mockResolvedValue("enabled");
  });

  it("keep awake while working: on by default, saved on the server, with the live status", async () => {
    render(<KeepAwakeSettings />);
    const toggle = screen.getByRole("switch", { name: "Keep this device awake while a chat is working" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Keeping this device awake: a chat is working."));
    expect(request).toHaveBeenCalledWith("GET", "/power");
    expect(screen.getByText(/closed laptop lid/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(api.updateSettings).toHaveBeenCalledWith({ power: { whileWorking: false } });
  });

  it("Show in Dock, Open at login and ⌘Q go to the app, not the server", async () => {
    render(<DesktopAppSettings />);
    const dock = screen.getByRole("switch", { name: "Show in Dock" });
    await waitFor(() => expect(dock.hasAttribute("disabled")).toBe(false));
    fireEvent.click(dock);
    expect(desktop.setDesktopPrefs).toHaveBeenCalledWith({ showInDock: false });
    fireEvent.click(screen.getByRole("switch", { name: "⌘Q keeps Glade in the menu bar" }));
    expect(desktop.setDesktopPrefs).toHaveBeenCalledWith({ quitToMenuBar: false });
    const login = screen.getByRole("switch", { name: "Open at login" });
    expect(login.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(login);
    expect(desktop.setLoginItem).toHaveBeenCalledWith(true);
    await waitFor(() => expect(login.getAttribute("aria-checked")).toBe("true"));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("shows why Open at login failed", async () => {
    vi.mocked(desktop.setLoginItem).mockRejectedValue(new Error("Couldn't change Open at login: denied"));
    render(<DesktopAppSettings />);
    const login = screen.getByRole("switch", { name: "Open at login" });
    await waitFor(() => expect(login.hasAttribute("disabled")).toBe(false));
    fireEvent.click(login);
    await waitFor(() => expect(screen.getByText(/denied/)).toBeTruthy());
  });
});
