/**
 * QR code as SVG (I-126: the pairing invite). Encoded with `uqr` (MIT, no dependencies); drawn
 * as one path of dark modules on a light plate with a 4-module quiet zone, in both themes
 * (`--pi-qr-fg` / `--pi-qr-bg`), because phone cameras don't reliably read inverted codes.
 *
 *   <QrCode value={invite.link} size={184} label="QR code of the pairing link" />
 */
import { useMemo } from "preact/hooks";
import { encode } from "uqr";
import { cn } from "@/lib/cn";

export interface QrCodeProps {
  value: string;
  /** Rendered width and height in px. */
  size?: number;
  /** Accessible name. */
  label?: string;
  class?: string;
}

/** Quiet zone in modules (the QR spec asks for 4). */
const QUIET = 4;

/** The dark modules of `value` as one SVG path (unit squares), plus the side length with the quiet zone. */
export function qrPath(value: string): { path: string; size: number } {
  const { data, size } = encode(value, { ecc: "M", border: 0 });
  let path = "";
  for (let y = 0; y < size; y++) {
    const row = data[y]!;
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      // One rectangle per horizontal run of dark modules keeps the path short.
      const start = x;
      while (x < size && row[x]) x++;
      path += `M${start + QUIET} ${y + QUIET}h${x - start}v1h${start - x}z`;
    }
  }
  return { path, size: size + QUIET * 2 };
}

export function QrCode({ value, size = 184, label = "QR code", class: className }: QrCodeProps) {
  const qr = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shape-rendering="crispEdges"
      class={cn("block shrink-0 rounded-[8px]", className)}
    >
      <rect width={qr.size} height={qr.size} class="fill-qr-bg" />
      <path d={qr.path} class="fill-qr-fg" />
    </svg>
  );
}
