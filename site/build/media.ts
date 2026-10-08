/**
 * The site's media contract (PLAN.md I-209): which screenshots and videos the page shows, read
 * from `site/public/media/<name>.<ext>`, and the pure HTML rendering for each one. A missing file
 * renders a clearly marked placeholder with the same aspect ratio, so the page works before the
 * captures exist and picks the real files up as soon as they're dropped in.
 *
 * Used at build time (and by the dev server) through `vite-media-plugin.ts`; nothing here runs in
 * the browser.
 */

export type MediaKind = "image" | "video";
/** How the capture is framed on the page: a Mac window or an iPhone screen. */
export type MediaFrame = "mac" | "iphone";

export interface MediaSpec {
  name: string;
  kind: MediaKind;
  frame: MediaFrame;
  /** What the capture shows, for screen readers (and the placeholder's label). */
  alt: string;
  /** `sizes` for the responsive image: how wide it's shown at each breakpoint. */
  sizes: string;
  /** Above the fold: load eagerly with high priority. */
  eager?: boolean;
  /** Render nothing (not a placeholder) when the file is missing. */
  optional?: boolean;
}

const MAC_SIZES = "(min-width: 1100px) 1000px, 92vw";
const PHONE_SIZES = "(min-width: 800px) 300px, 60vw";

export const MEDIA: readonly MediaSpec[] = [
  { name: "hero", kind: "video", frame: "mac", eager: true, sizes: "(min-width: 1240px) 1160px, 94vw",
    alt: "Glade with a project of several chats, a reply streaming in with its thinking and tool calls, and sub-agent cards above the message box" },
  { name: "agents", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Choosing between pi, Claude Code and Codex for a new chat" },
  { name: "subagents", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "A chat starting three sub-agents that work in parallel, their cards updating until their reports come back" },
  { name: "composer", kind: "video", frame: "mac", optional: true, sizes: "(min-width: 1100px) 520px, 92vw",
    alt: "The Send button switching between Steer, Follow-up and Ask Aside while ⌘ or ⌥ is held" },
  { name: "remote", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Settings → Remote Access on the Mac, with Share This Device and the connected devices" },
  { name: "iphone-list", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "The iPhone app's chat list, with chats from every connected Mac" },
  { name: "iphone-chat", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "A chat open on the iPhone, with the touch composer" },
  { name: "local-models", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Settings → Local Models with a model loaded in llama-server" },
  { name: "worktrees", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A worktree chat with the changes panel open on a diff" },
  { name: "search", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "⌘K finding a chat and a bookmark, then jumping to the message" },
  { name: "bookmarks", kind: "image", frame: "mac", sizes: "(min-width: 1100px) 520px, 92vw",
    alt: "A bookmarked reply with its ribbon, and the bookmark list in the chat header" },
  { name: "terminal", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A terminal tab open next to a chat" },
  { name: "iphone-voice", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "Voice mode on the iPhone, reading a reply aloud with the current word highlighted" },
];

/** Placeholder sizes, in the captures' own proportions (Mac window ~1440×900 at 2×; iPhone simulator). */
export const PLACEHOLDER_SIZE: Record<MediaFrame, { width: number; height: number }> = {
  mac: { width: 2880, height: 1800 },
  iphone: { width: 1206, height: 2622 },
};

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const VIDEO_EXTS = [".webm", ".mp4"] as const;

export interface FoundImage {
  /** File name inside `media/`. */
  file: string;
  width: number;
  height: number;
  /** Optimised WebP versions (build only), file names inside `media/`. */
  variants: { file: string; width: number }[];
}

/** What exists on disk for one spec: a still (the image, or a video's poster) and/or the videos. */
export interface FoundMedia {
  still?: FoundImage;
  webm?: string;
  mp4?: string;
}

/** Picks the files belonging to `name` out of a directory listing. */
export function findFiles(name: string, files: readonly string[]): { still?: string; webm?: string; mp4?: string } {
  const has = (ext: string) => files.find((f) => f.toLowerCase() === `${name}${ext}`);
  const still = IMAGE_EXTS.map(has).find(Boolean);
  return { still, webm: has(".webm"), mp4: has(".mp4") };
}

/** Widths of the WebP variants worth making for an image of this width. */
export function variantWidths(frame: MediaFrame, naturalWidth: number): number[] {
  const wanted = frame === "mac" ? [960, 1600, 2400] : [480, 800];
  const widths = wanted.filter((w) => w < naturalWidth * 0.95);
  return [...widths, Math.min(naturalWidth, frame === "mac" ? 2880 : 1206)];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The still's best URL for a poster or slices: a WebP around 1600–2400 px wide when there is one. */
export function posterUrl(still: FoundImage, base: string): string {
  const pick = [...still.variants].sort((a, b) => a.width - b.width).find((v) => v.width >= 1600) ?? still.variants.at(-1);
  return `${base}media/${pick ? pick.file : still.file}`;
}

function pictureHtml(spec: MediaSpec, still: FoundImage, base: string): string {
  const srcset = still.variants.map((v) => `${base}media/${v.file} ${v.width}w`).join(", ");
  const loading = spec.eager ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
  return (
    `<picture class="media-el">` +
    (srcset ? `<source type="image/webp" srcset="${srcset}" sizes="${esc(spec.sizes)}">` : "") +
    `<img src="${base}media/${still.file}" width="${still.width}" height="${still.height}" alt="${esc(spec.alt)}" ${loading} decoding="async">` +
    `</picture>`
  );
}

function videoHtml(spec: MediaSpec, found: FoundMedia, base: string): string {
  const size = found.still ?? PLACEHOLDER_SIZE[spec.frame];
  const poster = found.still ? ` poster="${posterUrl(found.still, base)}"` : "";
  // Sources carry data-src: the page loads them only when the video comes near the viewport.
  const sources =
    (found.webm ? `<source data-src="${base}media/${found.webm}" type="video/webm">` : "") +
    (found.mp4 ? `<source data-src="${base}media/${found.mp4}" type="video/mp4">` : "");
  return (
    `<video class="media-el" data-video${spec.eager ? " data-eager" : ""} muted loop playsinline preload="none"` +
    ` width="${size.width}" height="${size.height}"${poster} aria-label="${esc(spec.alt)}">${sources}</video>`
  );
}

function placeholderHtml(spec: MediaSpec): string {
  const what = spec.kind === "video" ? "video" : "screenshot";
  const label = `Placeholder: ${spec.name} ${what}`;
  const skeleton =
    spec.frame === "mac"
      ? `<span class="ph-side"><i></i><i></i><i></i><i></i><i></i></span>` +
        `<span class="ph-main"><span class="ph-tabs"></span><i></i><i></i><i></i><i></i><span class="ph-composer"></span></span>`
      : `<span class="ph-phone"><span class="ph-tabs"></span><i></i><i></i><i></i><i></i><span class="ph-composer"></span></span>`;
  return (
    `<span class="media-el ph ph--${spec.frame}" role="img" aria-label="${esc(`${label}. ${spec.alt}`)}">` +
    `${skeleton}<span class="ph-tag">${esc(label)}</span></span>`
  );
}

/**
 * The markup for one media slot. The wrapper carries the aspect ratio (so nothing shifts while
 * loading), the frame style and whether it's real (`data-state`).
 */
export function renderMedia(spec: MediaSpec, found: FoundMedia, base: string): string {
  const hasVideo = Boolean(found.webm || found.mp4);
  const real = spec.kind === "video" ? hasVideo || Boolean(found.still) : Boolean(found.still);
  if (!real && spec.optional) return "";
  const size = found.still ?? PLACEHOLDER_SIZE[spec.frame];
  let inner: string;
  if (!real) inner = placeholderHtml(spec);
  else if (spec.kind === "video" && hasVideo) inner = videoHtml(spec, found, base);
  else inner = pictureHtml(spec, found.still!, base);
  const kind = real && spec.kind === "video" && hasVideo ? "video" : "image";
  return (
    `<div class="media media--${spec.frame}" data-media="${spec.name}" data-state="${real ? "real" : "placeholder"}"` +
    ` data-kind="${kind}" style="aspect-ratio: ${size.width} / ${size.height}">${inner}</div>`
  );
}

/** Replaces every `<glade-media name="…"></glade-media>` in the page with its markup. */
export function injectMedia(html: string, render: (name: string) => string): string {
  return html.replace(/<glade-media\s+name="([\w-]+)"\s*><\/glade-media>/g, (_, name: string) => render(name));
}
