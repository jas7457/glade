/** I-147: Remote Access's keep-awake rows (AC by default, battery optional). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { defaultSettings } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({ api: { updateSettings: vi.fn() }, request: vi.fn() }));

import { api, request } from "@glade/app-core/lib/api";
import { settings } from "@glade/app-core/state/store";
import { KeepAwakeRows } from "./KeepAwakeRows";

describe("KeepAwakeRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value = defaultSettings();
    vi.mocked(api.updateSettings).mockImplementation(async () => settings.value);
    vi.mocked(request).mockResolvedValue({ reasons: [], text: "", held: false, canHold: true, powerSource: "battery", sharedSkipped: "battery" });
  });

  it("on while shared (AC), battery off by default; says when the battery rule applies", async () => {
    render(<KeepAwakeRows />);
    expect(screen.getByRole("switch", { name: "Keep this device awake while it's shared" }).getAttribute("aria-checked")).toBe("true");
    const battery = screen.getByRole("switch", { name: "Also on battery power" });
    expect(battery.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/on battery power/));
    fireEvent.click(battery);
    expect(api.updateSettings).toHaveBeenCalledWith({ power: { whileSharedOnBattery: true } });
    fireEvent.click(screen.getByRole("switch", { name: "Keep this device awake while it's shared" }));
    expect(api.updateSettings).toHaveBeenCalledWith({ power: { whileShared: false } });
    expect(screen.queryByRole("switch", { name: "Also on battery power" })).toBeNull();
  });
});
