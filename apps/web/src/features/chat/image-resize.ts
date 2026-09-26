/**
 * Downscale attached images to the model's limits before sending (like ChatGPT / Claude.ai do).
 *
 * `planImageEncodes` is the pure part: given the source size/type and the limits it returns the
 * ordered list of encodes to try (or none, when the original can be sent as is). `prepareImage`
 * is the thin browser wrapper: decode (respecting EXIF orientation), draw, encode each attempt
 * until one fits `maxBytes`.
 */
import { DEFAULT_IMAGE_LIMITS, type ImageLimits } from "@pi-ui/protocol";

export type EncodeMime = "image/jpeg" | "image/png";

export interface EncodeAttempt {
  width: number;
  height: number;
  mimeType: EncodeMime;
  /** JPEG quality 0-1 (unset for PNG). */
  quality?: number;
}

export interface SourceImage {
  width: number;
  height: number;
  mimeType: string;
  /** Size of the original file in bytes. */
  bytes: number;
}

/** Formats every image-capable provider accepts as is. */
const PASSTHROUGH_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Never step JPEG quality below this; shrink dimensions instead. */
const MIN_QUALITY = 40;
const QUALITY_STEP = 15;
/** Each dimension step scales by this factor. */
const SCALE_STEP = 0.75;
const MAX_SCALE_STEPS = 8;
const MIN_EDGE = 64;

/** Scale `width × height` down (never up) to fit within `maxWidth × maxHeight`, keeping aspect. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (scale >= 1) return { width, height };
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The encodes to try, in order; the first whose output fits `limits.maxBytes` wins.
 * Returns `[]` when the original already fits (dimensions, bytes and a widely supported type).
 *
 *  1. PNG at the fitted size, when the source is PNG (screenshots, transparency).
 *  2. JPEG at the fitted size, stepping quality down from `jpegQuality` to MIN_QUALITY.
 *  3. JPEG at MIN_QUALITY-ish quality with the dimensions shrinking by SCALE_STEP each time.
 */
export function planImageEncodes(source: SourceImage, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): EncodeAttempt[] {
  const fitted = fitWithin(source.width, source.height, limits.maxWidth, limits.maxHeight);
  const resized = fitted.width !== source.width || fitted.height !== source.height;
  if (!resized && source.bytes <= limits.maxBytes && PASSTHROUGH_TYPES.has(source.mimeType)) return [];

  const attempts: EncodeAttempt[] = [];
  if (source.mimeType === "image/png") attempts.push({ ...fitted, mimeType: "image/png" });

  const startQuality = Math.max(MIN_QUALITY, Math.min(100, limits.jpegQuality));
  for (let q = startQuality; q > MIN_QUALITY; q -= QUALITY_STEP) attempts.push({ ...fitted, mimeType: "image/jpeg", quality: q / 100 });
  attempts.push({ ...fitted, mimeType: "image/jpeg", quality: MIN_QUALITY / 100 });

  let { width, height } = fitted;
  for (let i = 0; i < MAX_SCALE_STEPS; i++) {
    width = Math.round(width * SCALE_STEP);
    height = Math.round(height * SCALE_STEP);
    if (Math.min(width, height) < MIN_EDGE) break;
    attempts.push({ width, height, mimeType: "image/jpeg", quality: Math.max(MIN_QUALITY, startQuality - QUALITY_STEP) / 100 });
  }
  return attempts;
}

// ---------------------------------------------------------------------------------------------
// Browser wrapper
// ---------------------------------------------------------------------------------------------

export interface PreparedImage {
  mimeType: string;
  /** Base64 without the `data:` prefix. */
  data: string;
  width: number;
  height: number;
  /** Decoded byte size of `data`. */
  bytes: number;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : url;
}

function encode(bitmap: ImageBitmap, attempt: EncodeAttempt): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = attempt.width;
  canvas.height = attempt.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  if (attempt.mimeType === "image/jpeg") {
    // JPEG has no alpha: flatten transparent areas onto white instead of black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, attempt.width, attempt.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image"))), attempt.mimeType, attempt.quality),
  );
}

/** Decode, downscale and re-encode `file` so it fits `limits`. */
export async function prepareImage(file: Blob, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This image format isn't supported");
  }
  try {
    const attempts = planImageEncodes({ width: bitmap.width, height: bitmap.height, mimeType: file.type, bytes: file.size }, limits);
    if (attempts.length === 0) {
      return { mimeType: file.type, data: await blobToBase64(file), width: bitmap.width, height: bitmap.height, bytes: file.size };
    }
    for (const attempt of attempts) {
      const blob = await encode(bitmap, attempt);
      if (blob.size <= limits.maxBytes) {
        return { mimeType: attempt.mimeType, data: await blobToBase64(blob), width: attempt.width, height: attempt.height, bytes: blob.size };
      }
    }
    throw new Error("Image is too large to send, even after downscaling");
  } finally {
    bitmap.close();
  }
}
