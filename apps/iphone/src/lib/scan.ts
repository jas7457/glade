/**
 * Scanning a pairing QR code (I-164 step 6). Placeholder until the barcode scanner is wired in:
 * resolves with the scanned text, `null` when cancelled, rejects when scanning isn't possible.
 */
export async function scanPairingLink(): Promise<string | null> {
  throw new Error("Scanning isn't available yet. Use Paste Link or Enter Code.");
}
