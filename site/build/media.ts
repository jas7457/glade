/**
 * The site's media contract (PLAN.md I-209): which screenshots and videos the page shows, read
 * from `site/public/media/<name>.<ext>`, and the pure HTML rendering for each one. A missing file
 * renders a clearly marked placeholder with the same aspect ratio, so the page works before the
 * captures exist and picks the real files up as soon as they're dropped in.
 *
 * Feature sections show a capture's **focus** version (`<name>-focus.*`, just the part that
 * matters, captured at 3×) large in front, with the whole window behind it, dimmed and pushed back
 * in depth: `renderFocus` builds that stage from `focus.json` (the focus rectangle in the full
 * capture's CSS px), and `focusLayout` works out where each layer sits.
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
const PHONE_SIZES = "(min-width: 900px) 300px, 46vw";
/** The dimmed window behind a focus asset: never shown big, so a mid-size variant is plenty. */
export const BACK_SIZES = "(min-width: 900px) 760px, 88vw";

export const MEDIA: readonly MediaSpec[] = [
  // The hero's story (build/story.ts): from an empty new chat to the finished answer.
  { name: "hero-story", kind: "video", frame: "mac", eager: true, sizes: "(min-width: 1360px) 1280px, 94vw",
    alt: "Glade, from an empty new chat to a finished answer: picking the agent, asking a question, the chat appearing in the sidebar, and the reply streaming in with its thinking and tool calls" },
  // The older hero recording: the stand-in for hero-story until it exists, and the Open Graph image.
  { name: "hero", kind: "video", frame: "mac", eager: true, sizes: "(min-width: 1360px) 1280px, 94vw",
    alt: "Glade with a project of several chats, a follow-up typed into a chat, and the reply streaming in with its thinking, tool calls and two sub-agents" },
  { name: "agents", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A new chat in Glade with the agent menu open" },
  { name: "agents-focus", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "The agent menu above the message box: pi (the default), Claude Code and Codex" },
  { name: "agents-settings-focus", kind: "image", frame: "mac", sizes: "(min-width: 900px) 620px, 92vw",
    alt: "Settings → Agents: pi, Claude Code and Codex installed and switched on" },
  { name: "subagents", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "A chat in Glade starting three sub-agents" },
  { name: "subagents-focus", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "A chat starting three sub-agents that work in parallel, their cards updating until their reports come back" },
  { name: "subagent-tabs", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "A chat in Glade with one of its sub-agents open in its own tab beside it" },
  { name: "subagent-tabs-focus", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "A sub-agent's own tab: its tool calls as they run, a message typed to it asking to keep the database on a volume, and its reply as it changes the Dockerfile and checks the result" },
  { name: "composer", kind: "video", frame: "mac", optional: true, sizes: MAC_SIZES,
    alt: "Glade with an agent working and a message being typed" },
  { name: "composer-focus", kind: "video", frame: "mac", optional: true, sizes: MAC_SIZES,
    alt: "The Send button switching between Steer, Follow-up and Ask Aside while ⌘ or ⌥ is held" },
  { name: "remote", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Settings → Remote Access on the Mac" },
  { name: "remote-focus", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Remote Access connections: Connect to a Device, Share This Device, and a MacBook Air and an iPhone using this Mac" },
  { name: "iphone-list", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "The iPhone app's chat list, with chats from every connected Mac" },
  { name: "iphone-chat", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "A chat open on the iPhone, with sub-agent cards and the touch composer" },
  { name: "local-models", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Settings → Local Models in Glade" },
  { name: "local-models-focus", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "Local Models: llama-server's memory bar and its models, one loaded and used by a chat" },
  { name: "worktrees", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A worktree chat in Glade with the changes panel open" },
  { name: "worktrees-focus", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "The changes panel of a worktree chat: four changed files, two of them with their diffs open" },
  { name: "search", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "Glade with the ⌘K palette" },
  { name: "search-focus", kind: "video", frame: "mac", sizes: MAC_SIZES,
    alt: "⌘K finding a chat, a message and two bookmarks for “backoff”, then jumping to the message" },
  { name: "bookmarks", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A chat in Glade with its bookmark list open" },
  { name: "bookmarks-focus", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "The chat header's bookmark list over a chat with sub-agent cards and a bookmarked reply" },
  { name: "terminal", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A terminal tab open next to a chat in Glade" },
  { name: "terminal-focus", kind: "image", frame: "mac", sizes: MAC_SIZES,
    alt: "A terminal tab beside the chat tab, showing git log, git status and pnpm test" },
  { name: "iphone-voice", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "Voice mode on the iPhone, reading a reply aloud with the current word highlighted" },
  { name: "iphone-voice-chat", kind: "image", frame: "iphone", sizes: PHONE_SIZES,
    alt: "Voice mode minimized into the chat on the iPhone, the highlight following along in the reply" },
];

export const mediaSpec = (name: string): MediaSpec | undefined => MEDIA.find((m) => m.name === name);

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

function pictureHtml(spec: MediaSpec, still: FoundImage, base: string, alt = spec.alt): string {
  const srcset = still.variants.map((v) => `${base}media/${v.file} ${v.width}w`).join(", ");
  const loading = spec.eager ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
  return (
    `<picture class="media-el">` +
    (srcset ? `<source type="image/webp" srcset="${srcset}" sizes="${esc(spec.sizes)}">` : "") +
    `<img src="${base}media/${still.file}" width="${still.width}" height="${still.height}" alt="${esc(alt)}" ${loading} decoding="async">` +
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

// ---------- Focus stages ----------

/** The full captures' window size in CSS px: the coordinate space of `focus.json`. */
export const FULL_WINDOW = { width: 1440, height: 900 } as const;

/** A focus region in the full capture's CSS px (`focus.json`). */
export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Reads `focus.json` (`{ name: {x,y,w,h} }`), skipping anything malformed or empty. */
export function parseFocusJson(text: string): Record<string, FocusRect> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, FocusRect> = {};
  if (!data || typeof data !== "object") return out;
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    const r = value as Partial<FocusRect> | null;
    if (!r || ![r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    if (r.w! <= 0 || r.h! <= 0) continue;
    out[name] = { x: r.x!, y: r.y!, w: r.w!, h: r.h! };
  }
  return out;
}

export type Side = "left" | "right";

export interface FocusLayoutOptions {
  /** Which side the full window sits on; the focus asset leans the other way. */
  side: Side;
  /** Width of the full window, % of the stage. */
  backWidth?: number;
  /** Width of the focus asset, % of the stage. Default: big enough to show it at ~1.1× app size. */
  frontWidth?: number;
  /** The stage's width on a desktop window (the page's container), to size the focus asset. */
  container?: number;
  /** The focus asset's scale on that stage, relative to the app's own size. */
  scale?: number;
  /** Most the focus asset may take, % of the stage's width. */
  maxFrontWidth?: number;
  /** Tallest the focus asset may be, % of the stage's width. */
  maxFrontHeight?: number;
  /** How much of the window's side stays uncovered, % of the stage's width. */
  peek?: number;
  /** How much of the window's top stays uncovered, % of the stage's width. */
  peekTop?: number;
}

/** Where each layer of a focus stage sits. Everything is in % of the stage's width. */
export interface FocusLayout {
  /** The stage's height. */
  height: number;
  back: { x: number; y: number; w: number; h: number };
  front: { x: number; y: number; w: number; h: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/**
 * Lays out a focus stage: the full window on one side, and the focus asset in front of it, centred
 * where the region sits in the window as far as the stage allows, but leaving a strip of the window
 * uncovered beside and above it, so it reads as "this part of that window".
 */
export function focusLayout(rect: FocusRect, opts: FocusLayoutOptions): FocusLayout {
  const {
    side,
    backWidth = 72,
    container = 1160,
    scale = 1.12,
    maxFrontWidth = 88,
    maxFrontHeight = 58,
    peek = 15,
    peekTop = 6,
  } = opts;
  const aspect = rect.h / rect.w;
  let fw = opts.frontWidth ?? Math.min(maxFrontWidth, ((rect.w * scale) / container) * 100);
  if (opts.frontWidth === undefined && fw * aspect > maxFrontHeight) fw = maxFrontHeight / aspect;
  const fh = fw * aspect;

  const bw = backWidth;
  const bh = (bw * FULL_WINDOW.height) / FULL_WINDOW.width;
  const bx = side === "left" ? 0 : 100 - bw;
  const by = 0;

  // Centre of the region as it appears on the back window.
  const cx = bx + (bw * (rect.x + rect.w / 2)) / FULL_WINDOW.width;
  const cy = by + (bh * (rect.y + rect.h / 2)) / FULL_WINDOW.height;
  const fx = side === "left" ? clamp(cx - fw / 2, Math.min(peek, 100 - fw), 100 - fw) : clamp(cx - fw / 2, 0, 100 - fw - peek);
  const fy = Math.max(cy - fh / 2, peekTop);

  return {
    height: r2(Math.max(by + bh, fy + fh)),
    back: { x: r2(bx), y: r2(by), w: r2(bw), h: r2(bh) },
    front: { x: r2(fx), y: r2(fy), w: r2(fw), h: r2(fh) },
  };
}

export interface FocusStageOptions {
  side: Side;
  /** Override the focus asset's width on desktop (% of the stage). */
  frontWidth?: number;
  /** Override the window's width on desktop (% of the stage). */
  backWidth?: number;
  /** Extra layers (e.g. a second card or phones), placed by the section's own CSS. */
  extra?: string;
  /** Extra class names for the stage. */
  className?: string;
}

export interface FocusSources {
  full?: { spec: MediaSpec; found: FoundMedia };
  focus?: { spec: MediaSpec; found: FoundMedia };
  rect?: FocusRect;
}

const isReal = (spec: MediaSpec, found: FoundMedia) => Boolean(found.still || (spec.kind === "video" && (found.webm || found.mp4)));

/** CSS custom properties for both layouts: desktop (`--d*`) and phones (`--m*`, front full width). */
function layoutVars(rect: FocusRect, opts: FocusStageOptions): string {
  const d = focusLayout(rect, { side: opts.side, frontWidth: opts.frontWidth, backWidth: opts.backWidth });
  const m = focusLayout(rect, { side: opts.side, backWidth: 84, frontWidth: 100, peek: 0, peekTop: 10 });
  const vars = (p: string, l: FocusLayout) =>
    `--${p}h:${l.height};--${p}bx:${l.back.x};--${p}by:${l.back.y};--${p}bw:${l.back.w};` +
    `--${p}fx:${l.front.x};--${p}fy:${l.front.y};--${p}fw:${l.front.w}`;
  const ring = (n: number, of: number) => r2((n / of) * 100);
  return (
    `${vars("d", d)};${vars("m", m)};` +
    `--rx:${ring(rect.x, FULL_WINDOW.width)};--ry:${ring(rect.y, FULL_WINDOW.height)};` +
    `--rw:${ring(rect.w, FULL_WINDOW.width)};--rh:${ring(rect.h, FULL_WINDOW.height)}`
  );
}

/**
 * A feature's stage. With the focus asset and its rectangle: the full window behind (always a still,
 * dimmed, tilted back, the region outlined) and the focus asset in front. Without them it falls back
 * to the full capture on its own, and to a placeholder when nothing exists yet.
 */
export function renderFocus(name: string, src: FocusSources, opts: FocusStageOptions, base: string): string {
  const { full, focus, rect } = src;
  const fullReal = full ? isReal(full.spec, full.found) : false;
  const focusReal = focus ? isReal(focus.spec, focus.found) : false;
  const extra = opts.extra ?? "";
  const cls = (more: string) => ["focus-stage", more, opts.className].filter(Boolean).join(" ");

  if (focus && focusReal && rect) {
    // The back is decoration (the front carries the alt text), and always a still: no second video.
    const back =
      full?.found.still
        ? `<div class="focus-back" data-focus-back aria-hidden="true"><div class="window">` +
          `<div class="media media--mac" data-media="${full.spec.name}" data-state="real" data-kind="image"` +
          ` style="aspect-ratio: ${FULL_WINDOW.width} / ${FULL_WINDOW.height}">` +
          pictureHtml({ ...full.spec, sizes: BACK_SIZES, eager: false }, full.found.still, base, "") +
          `</div><span class="focus-dim" data-focus-dim></span></div>` +
          `<span class="focus-ring" data-focus-ring></span></div>`
        : "";
    const front = `<div class="focus-front window" data-focus-front>${renderMedia(focus.spec, focus.found, base)}</div>`;
    const r = [rect.x / FULL_WINDOW.width, rect.y / FULL_WINDOW.height, rect.w / FULL_WINDOW.width, rect.h / FULL_WINDOW.height]
      .map((n) => Math.round(n * 1e4) / 1e4)
      .join(" ");
    return (
      `<div class="${cls(back ? "" : "focus-stage--solo")}" data-focus-stage="${name}" data-side="${opts.side}"` +
      ` data-focus-rect="${r}" style="${layoutVars(rect, opts)}">${back}${front}${extra}</div>`
    );
  }
  // Fallbacks: the full capture on its own (or its placeholder); nothing for a missing optional one.
  if (full && (fullReal || !full.spec.optional)) {
    return `<div class="${cls("focus-stage--plain")}" data-side="${opts.side}"><div class="window">${renderMedia(full.spec, full.found, base)}</div>${extra}</div>`;
  }
  if (focus && !focus.spec.optional) {
    return `<div class="${cls("focus-stage--plain")}" data-side="${opts.side}"><div class="window">${renderMedia(focus.spec, {}, base)}</div>${extra}</div>`;
  }
  return "";
}

export interface FocusTag {
  name: string;
  attrs: Record<string, string>;
  inner: string;
}

/**
 * Replaces every `<glade-focus name="…" side="left|right" [front="%"] [back="%"] [class="…"]>extra</glade-focus>`
 * with its stage. Run before `injectMedia`, so `<glade-media>` tags inside the extra layers still expand.
 */
export function injectFocus(html: string, render: (tag: FocusTag) => string): string {
  return html.replace(/<glade-focus\s+([^>]*)>([\s\S]*?)<\/glade-focus>/g, (_, attrText: string, inner: string) => {
    const attrs: Record<string, string> = {};
    for (const m of attrText.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]!] = m[2]!;
    if (!attrs.name) throw new Error("[media] <glade-focus> needs a name");
    return render({ name: attrs.name, attrs, inner: inner.trim() });
  });
}

/** Stage options from a tag's attributes. */
export function focusOptions(tag: FocusTag): FocusStageOptions {
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  return {
    side: tag.attrs.side === "left" ? "left" : "right",
    frontWidth: num(tag.attrs.front),
    backWidth: num(tag.attrs.back),
    className: tag.attrs.class,
    extra: tag.inner,
  };
}
