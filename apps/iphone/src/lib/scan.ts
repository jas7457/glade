/**
 * Scanning a pairing QR code (I-164 step 6) with Tauri's barcode scanner plugin
 * (`tauri-plugin-barcode-scanner`, registered for mobile in src-tauri/src/lib.rs).
 *
 * `scanPairingLink()` asks for the camera (the first time iOS shows its prompt with the
 * NSCameraUsageDescription from src-tauri/Info.ios.plist), scans **QR codes only** and resolves
 * with the scanned text: the Mac's Share This Device… link, which the Connect screen hands to
 * `startPairing` (state/connect.ts → parsePairInput + the HTTPS-only rule). It resolves `null`
 * when the user cancels, and rejects with a message to show when scanning isn't possible
 * (camera denied, no camera, not inside the app).
 *
 * The plugin and the overlay are injected (`ScanDeps`) so the flow is unit-tested without a
 * camera (scan.test.ts); the simulator has none either.
 */
import type { PermissionState } from "@tauri-apps/api/core";
import { inShell } from "~/lib/secrets";

export const NOT_IN_APP_MESSAGE = "Scanning works in the Glade iPhone app. Here, use Paste Link or Enter Code.";
export const CAMERA_DENIED_MESSAGE = "Glade can't use the camera. Allow camera access in Settings → Glade, or use Paste Link or Enter Code.";
export const NO_CAMERA_MESSAGE = "This device has no camera. Use Paste Link or Enter Code.";

/** The plugin functions scanning needs (the real ones: `pluginDeps()`). */
export interface ScannerPlugin {
  checkPermissions(): Promise<PermissionState>;
  requestPermissions(): Promise<PermissionState>;
  /** Resolves with the first QR code's text; rejects with "cancelled" after `cancel()`. */
  scanQr(): Promise<string>;
  cancel(): Promise<void>;
}

export interface ScanDeps {
  inShell(): boolean;
  plugin(): Promise<ScannerPlugin>;
  /** Shows the camera chrome (viewfinder, Cancel); returns its remover. */
  showOverlay(onCancel: () => void): () => void;
}

async function pluginDeps(): Promise<ScannerPlugin> {
  const p = await import("@tauri-apps/plugin-barcode-scanner");
  return {
    checkPermissions: p.checkPermissions,
    requestPermissions: p.requestPermissions,
    // Windowed: the camera preview goes behind the (transparent) WebView, under our overlay.
    scanQr: async () => (await p.scan({ windowed: true, formats: [p.Format.QRCode] })).content ?? "",
    cancel: p.cancel,
  };
}

const defaultDeps: ScanDeps = {
  inShell,
  plugin: pluginDeps,
  showOverlay: (onCancel) => {
    let remove: (() => void) | null = null;
    let removed = false;
    void import("~/lib/scan-overlay").then(({ showScanOverlay }) => {
      if (!removed) remove = showScanOverlay(onCancel);
    });
    return () => {
      removed = true;
      remove?.();
    };
  },
};

/** The plugin's rejections: strings, Errors, or (iOS `invoke.reject`) objects with a `message`; normalise to text. */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Cancels the running scan, if any (it then resolves `null`). */
let cancelRunning: (() => void) | null = null;

export function cancelScan(): void {
  cancelRunning?.();
}

export async function scanPairingLink(deps: ScanDeps = defaultDeps): Promise<string | null> {
  if (!deps.inShell()) throw new Error(NOT_IN_APP_MESSAGE);
  cancelScan();
  const plugin = await deps.plugin();

  let permission = await plugin.checkPermissions();
  if (permission !== "granted" && permission !== "denied") permission = await plugin.requestPermissions();
  if (permission !== "granted") throw new Error(CAMERA_DENIED_MESSAGE);

  let cancelled = false;
  // Cancel settles the scan itself too, in case the plugin's cancel doesn't reject the scan.
  let settleCancelled: (() => void) | null = null;
  const whenCancelled = new Promise<null>((resolve) => (settleCancelled = () => resolve(null)));
  const cancel = () => {
    cancelled = true;
    settleCancelled?.();
    void plugin.cancel().catch(() => {});
  };
  cancelRunning = cancel;
  const hide = deps.showOverlay(cancel);
  try {
    const text = await Promise.race([plugin.scanQr(), whenCancelled]);
    if (cancelled || text === null) return null;
    return text.trim() || null;
  } catch (err) {
    const message = messageOf(err);
    if (cancelled || /cancel/i.test(message)) return null;
    if (/no camera/i.test(message)) throw new Error(NO_CAMERA_MESSAGE);
    if (/permission|denied/i.test(message)) throw new Error(CAMERA_DENIED_MESSAGE);
    throw new Error(`Couldn't scan: ${message}`);
  } finally {
    if (cancelRunning === cancel) cancelRunning = null;
    hide();
  }
}
