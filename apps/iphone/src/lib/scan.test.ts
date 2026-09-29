import type { PermissionState } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { CAMERA_DENIED_MESSAGE, NO_CAMERA_MESSAGE, NOT_IN_APP_MESSAGE, scanPairingLink, type ScanDeps, type ScannerPlugin } from "./scan";

function setup(opts: { inShell?: boolean; permission?: PermissionState; afterRequest?: PermissionState; scan?: () => Promise<string>; cancelRejects?: boolean } = {}) {
  let rejectScan: ((err: unknown) => void) | null = null;
  const plugin: ScannerPlugin = {
    checkPermissions: vi.fn(async () => opts.permission ?? "granted"),
    requestPermissions: vi.fn(async () => opts.afterRequest ?? "granted"),
    scanQr: vi.fn(
      opts.scan ??
        (() =>
          new Promise<string>((_, reject) => {
            rejectScan = reject;
          })),
    ),
    cancel: vi.fn(async () => {
      if (opts.cancelRejects !== false) rejectScan?.("cancelled");
    }),
  };
  const hide = vi.fn();
  let onCancel: (() => void) | null = null;
  const deps: ScanDeps = {
    inShell: () => opts.inShell ?? true,
    plugin: async () => plugin,
    showOverlay: vi.fn((cancel: () => void) => {
      onCancel = cancel;
      return hide;
    }),
  };
  return { plugin, deps, hide, cancel: () => onCancel?.() };
}

describe("scanPairingLink", () => {
  it("rejects with a clear message outside the app (Chrome)", async () => {
    const { deps, plugin } = setup({ inShell: false });
    await expect(scanPairingLink(deps)).rejects.toThrow(NOT_IN_APP_MESSAGE);
    expect(plugin.checkPermissions).not.toHaveBeenCalled();
  });

  it("scans QR codes and resolves with the trimmed text, then hides the overlay", async () => {
    const { deps, plugin, hide } = setup({ scan: async () => "  glade://pair?e=x&g=y&u=https://m.ts.net \n" });
    await expect(scanPairingLink(deps)).resolves.toBe("glade://pair?e=x&g=y&u=https://m.ts.net");
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(deps.showOverlay).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("asks for the camera the first time", async () => {
    const { deps, plugin } = setup({ permission: "prompt", afterRequest: "granted", scan: async () => "text" });
    await expect(scanPairingLink(deps)).resolves.toBe("text");
    expect(plugin.requestPermissions).toHaveBeenCalledOnce();
  });

  it("points to Settings when the camera is denied (now or earlier)", async () => {
    const asked = setup({ permission: "prompt", afterRequest: "denied" });
    await expect(scanPairingLink(asked.deps)).rejects.toThrow(CAMERA_DENIED_MESSAGE);
    expect(asked.plugin.scanQr).not.toHaveBeenCalled();
    const earlier = setup({ permission: "denied" });
    await expect(scanPairingLink(earlier.deps)).rejects.toThrow("Allow camera access in Settings → Glade");
    expect(earlier.plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it("resolves null when the user taps Cancel", async () => {
    const { deps, plugin, hide, cancel } = setup();
    const result = scanPairingLink(deps);
    await vi.waitFor(() => expect(plugin.scanQr).toHaveBeenCalled());
    cancel();
    await expect(result).resolves.toBeNull();
    expect(plugin.cancel).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("resolves null on Cancel even if the plugin leaves the scan pending", async () => {
    const { deps, plugin, hide, cancel } = setup({ cancelRejects: false });
    const result = scanPairingLink(deps);
    await vi.waitFor(() => expect(plugin.scanQr).toHaveBeenCalled());
    cancel();
    await expect(result).resolves.toBeNull();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("explains a missing camera (the simulator) and other failures", async () => {
    const sim = setup({ scan: () => Promise.reject("No camera available on this device (e.g., iOS Simulator)") });
    await expect(scanPairingLink(sim.deps)).rejects.toThrow(NO_CAMERA_MESSAGE);
    expect(sim.hide).toHaveBeenCalledOnce();
    // iOS rejects with an object carrying the message.
    const objectSim = setup({ scan: () => Promise.reject({ message: "No camera available on this device (e.g., iOS Simulator)" }) });
    await expect(scanPairingLink(objectSim.deps)).rejects.toThrow(NO_CAMERA_MESSAGE);
    const cancelled = setup({ scan: () => Promise.reject({ message: "cancelled" }) });
    await expect(scanPairingLink(cancelled.deps)).resolves.toBeNull();
    const other = setup({ scan: () => Promise.reject(new Error("boom")) });
    await expect(scanPairingLink(other.deps)).rejects.toThrow("Couldn't scan: boom");
  });
});
