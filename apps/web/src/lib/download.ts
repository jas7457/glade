/**
 * Browser downloads (I-123/I-124: files made on a remote environment can't be revealed in this
 * machine's Finder, so they're downloaded instead).
 */
import { ApiRequestError } from "./api";

/** `filename="x.html"` / `filename*=UTF-8''x.html` from a content-disposition header. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}

/** Fetch `url` and save the answer as a file through the browser. Returns the file name. */
export async function downloadUrl(url: string, fallbackName: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new ApiRequestError(res.status, message);
  }
  const name = filenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return name;
}
