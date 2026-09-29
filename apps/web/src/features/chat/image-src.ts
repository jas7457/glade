/**
 * Where a transcript image is shown from (I-157). Inline images (`data`) are `data:` URLs. Blob
 * references (`blob: "sha256:…"`) live on the chat's environment at `GET /api/blobs/<hex>`:
 *
 * - **No device token** (this machine, or a loopback environment connected before pairing): the
 *   plain URL goes straight into `<img src>` (the browser caches it; the server says immutable).
 * - **Paired remote environment:** an `<img>` can't send `Authorization: Bearer`, and the token
 *   must stay out of URLs, so the image is fetched with the token and shown as an object URL
 *   (cached for the page's lifetime; the content never changes). Until it arrives the source is
 *   `null`; `blobUrlsVersion` changes when one arrives, so components re-render.
 */
import { signal } from "@preact/signals";
import { blobHash, type ImageBlock } from "@glade/protocol";
import { authHeaders, localBaseUrl } from "@/lib/api";
import { connectionFor, type EnvHandle } from "@/state/env-registry";
import { useChatEnv } from "./chat-env";

export type ImageLike = Pick<ImageBlock, "mimeType" | "data" | "blob">;

/** Bumped whenever a fetched blob's object URL becomes available. */
export const blobUrlsVersion = signal(0);

const objectUrls = new Map<string, string>();
const pending = new Set<string>();
const failed = new Set<string>();

function tokenOf(conn: EnvHandle | undefined): string | null {
  const token = (conn as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token ? token : null;
}

/** The blob's URL on an environment's API base. */
export function blobUrl(baseUrl: string, hash: string): string {
  return `${baseUrl}/blobs/${hash}`;
}

/** An image's `src` in environment `envId` (`null` = unknown/local), or `null` while it loads. */
export function imageSrcIn(image: ImageLike, envId: string | null): string | null {
  if (image.data) return `data:${image.mimeType};base64,${image.data}`;
  const hash = blobHash(image.blob);
  if (!hash) return null;
  const conn = connectionFor(envId);
  const base = conn?.baseUrl ?? localBaseUrl();
  const url = blobUrl(base, hash);
  const token = tokenOf(conn);
  if (!token) return url;
  const key = `${base}|${hash}`;
  const ready = objectUrls.get(key);
  if (ready) return ready;
  if (!pending.has(key) && !failed.has(key)) {
    pending.add(key);
    void fetch(url, { headers: authHeaders(token) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        objectUrls.set(key, URL.createObjectURL(await res.blob()));
      })
      .catch(() => failed.add(key))
      .finally(() => {
        pending.delete(key);
        blobUrlsVersion.value++;
      });
  }
  return null;
}

/** Sources of `images` in the rendered chat's environment (re-renders when fetched ones arrive). */
export function useImageSrcs(images: readonly ImageLike[]): Array<string | null> {
  const envId = useChatEnv();
  void blobUrlsVersion.value; // subscribe
  return images.map((img) => imageSrcIn(img, envId));
}

export function useImageSrc(image: ImageLike): string | null {
  return useImageSrcs([image])[0] ?? null;
}

/** Tests: forget fetched blobs. */
export function resetBlobUrlCache(): void {
  objectUrls.clear();
  pending.clear();
  failed.clear();
}
