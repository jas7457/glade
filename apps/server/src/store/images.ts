/**
 * Images out of JSON (I-157, per chat since I-163): `externalizeImages` walks any protocol value
 * (a message, a tool result, an agent event, a whole transcript) of one chat and makes every
 * image a reference to a file in that chat's folder: inline images (`{ type: "image", mimeType,
 * data }`) are written there, and references to another chat's file or to a legacy shared
 * `sha256:` file are copied there (no sharing: deleting a chat deletes all its images). Unchanged
 * branches keep their identity, and a value with nothing to change comes back as the same object
 * (callers compare by identity). `resolvePromptImages` does the reverse for what a harness is fed.
 */
import { parseBlobRef, type ImageBlock, type PromptImage } from "@glade/protocol";
import type { BlobStore } from "./blobs.js";

type Json = Record<string, unknown>;

function isInlineImage(v: Json): v is Json & { type: "image"; mimeType: string; data: string } {
  return v.type === "image" && typeof v.data === "string" && v.data.length > 0 && typeof v.mimeType === "string" && v.mimeType.startsWith("image/");
}

function isRefImage(v: Json): v is Json & { type: "image"; mimeType: string; blob: string } {
  return v.type === "image" && typeof v.blob === "string" && typeof v.mimeType === "string" && !v.data;
}

/**
 * Make every image in `value` a reference to a file of chat `sessionId`. `count.n` counts the
 * images written or copied; `count.missing` counts foreign references whose file is gone (left
 * as they are).
 */
export function externalizeImages<T>(value: T, blobs: BlobStore, sessionId: string, count?: { n: number; missing?: number }): T {
  return walk(value, blobs, sessionId, `${sessionId}/`, count) as T;
}

function walk(value: unknown, blobs: BlobStore, sessionId: string, own: string, count?: { n: number; missing?: number }): unknown {
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = walk(value[i], blobs, sessionId, own, count);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  if (value === null || typeof value !== "object") return value;
  const obj = value as Json;
  if (isInlineImage(obj)) {
    const bytes = Buffer.from(obj.data, "base64");
    const blob = blobs.put(sessionId, bytes, obj.mimeType);
    const { data: _data, ...rest } = obj;
    const size = imageSize(bytes);
    if (count) count.n++;
    return { ...rest, blob: blob.ref, ...(size && rest.width === undefined ? size : {}) } satisfies Json;
  }
  if (isRefImage(obj)) {
    if (obj.blob.startsWith(own) || !parseBlobRef(obj.blob)) return value;
    // Another chat's (or the legacy shared) file: this chat gets its own copy.
    const bytes = blobs.read(obj.blob);
    if (!bytes) {
      if (count) count.missing = (count.missing ?? 0) + 1;
      return value;
    }
    if (count) count.n++;
    return { ...obj, blob: blobs.put(sessionId, bytes, obj.mimeType).ref } satisfies Json;
  }
  let out: Json | null = null;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === null || typeof v !== "object") continue;
    const next = walk(v, blobs, sessionId, own, count);
    if (next !== v) {
      out ??= { ...obj };
      out[key] = next;
    }
  }
  return out ?? value;
}

/** Whether a JSON text may hold an inline image (cheap pre-check before parsing). */
export function mayHaveInlineImage(json: string): boolean {
  return json.includes('"image"') && json.includes('"data"');
}

/** Every legacy (`sha256:`) hash referenced in a JSON text. */
export function legacyBlobRefsIn(json: string, into: Set<string> = new Set()): Set<string> {
  for (const m of json.matchAll(/"blob":"sha256:([0-9a-f]{64})"/g)) into.add(m[1]!);
  return into;
}

/** Prompt images for a harness: `blob` references read back into base64 `data`. */
export function resolvePromptImages(images: PromptImage[] | undefined, blobs: BlobStore): PromptImage[] | undefined {
  if (!images?.some((i) => i.blob && !i.data)) return images;
  return images.map((image) => {
    if (!image.blob || image.data) return image;
    const bytes = blobs.read(image.blob);
    if (!bytes) throw new BlobMissingError(image.blob);
    const { blob: _blob, ...rest } = image;
    return { ...rest, data: bytes.toString("base64") };
  });
}

/** An `ImageBlock` with its data inline (for readers that need the bytes, e.g. an export). */
export function inlineImage(image: ImageBlock, blobs: BlobStore): ImageBlock {
  if (image.data || !image.blob) return image;
  const bytes = blobs.read(image.blob);
  if (!bytes) return image;
  const { blob: _blob, ...rest } = image;
  return { ...rest, data: bytes.toString("base64") };
}

export class BlobMissingError extends Error {
  constructor(readonly ref: string) {
    super(`Image ${ref} is no longer available`);
  }
}

/** Pixel size of a PNG, GIF or JPEG (null for anything else or a malformed header). */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
      }
      i += 2 + len;
    }
  }
  return null;
}
