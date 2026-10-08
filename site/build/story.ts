/**
 * The hero's story (PLAN.md I-209): one recording (`hero-story.webm/.mp4/.png`) plus
 * `hero-story.json`, which splits it into steps, each with the region of the window that matters
 * (`{ width, height, duration, steps: [{ id, label, caption?, start, end, rect: {x,y,w,h} }] }`, CSS
 * px of the captured window and seconds). `renderStory` turns that into the hero's markup: the video
 * in a window, a spotlight layer, a caption, and the list of steps (buttons that seek). The player
 * itself is `src/story.ts`.
 *
 * Until the real recording exists, the plugin uses a stand-in: the older `hero` video with a
 * hand-written `dev/hero-story.sample.json`, and switches to the real files as soon as both land.
 *
 * Pure: used at build time (and by the dev server) through `vite-media-plugin.ts`.
 */
import { PLACEHOLDER_SIZE, posterUrl, renderMedia, type FoundMedia, type MediaSpec } from "./media.ts";

export interface StoryRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StoryStep {
  id: string;
  label: string;
  caption?: string;
  start: number;
  end: number;
  rect: StoryRect;
}

export interface Story {
  width: number;
  height: number;
  duration: number;
  steps: StoryStep[];
}

/** The site's own caption per planned step id, used when the JSON has none. */
export const STORY_CAPTIONS: Record<string, string> = {
  agent: "Start a new chat and pick the agent and model it runs on.",
  ask: "Ask for what you want, in your own words.",
  sidebar: "The chat appears in the sidebar and names itself.",
  work: "Follow along as it thinks, reads files and edits code.",
  done: "The answer lands, with every change ready to review.",
};

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Reads `hero-story.json`. Returns undefined when it isn't usable at all; drops single steps that
 * are malformed, sorts the rest by start time and clamps their rectangles to the window.
 */
export function parseStory(text: string): Story | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (!num(d.width) || !num(d.height) || !num(d.duration) || d.width <= 0 || d.height <= 0 || d.duration <= 0) return undefined;
  if (!Array.isArray(d.steps)) return undefined;
  const width = d.width;
  const height = d.height;
  const steps: StoryStep[] = [];
  for (const raw of d.steps as unknown[]) {
    const s = raw as Partial<StoryStep> | null;
    const r = s?.rect as Partial<StoryRect> | undefined;
    if (!s || typeof s.id !== "string" || !s.id || typeof s.label !== "string" || !num(s.start) || !num(s.end)) continue;
    if (!r || !num(r.x) || !num(r.y) || !num(r.w) || !num(r.h) || r.w <= 0 || r.h <= 0) continue;
    const x = Math.min(Math.max(r.x, 0), width);
    const y = Math.min(Math.max(r.y, 0), height);
    steps.push({
      id: s.id,
      label: s.label,
      caption: typeof s.caption === "string" && s.caption.trim() ? s.caption.trim() : undefined,
      start: Math.max(0, s.start),
      end: Math.max(s.start, s.end),
      rect: { x, y, w: Math.min(r.w, width - x), h: Math.min(r.h, height - y) },
    });
  }
  if (steps.length === 0) return undefined;
  steps.sort((a, b) => a.start - b.start);
  return { width, height, duration: d.duration, steps };
}

export const storyCaption = (step: StoryStep): string => step.caption ?? STORY_CAPTIONS[step.id] ?? step.label;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f4 = (n: number) => String(Math.round(n * 1e4) / 1e4);

const PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;

/**
 * The hero's markup. `media` is the recording (the real one or the stand-in); without a video it
 * falls back to the still or placeholder on its own, with the steps as a plain list.
 */
export function renderStory(story: Story, media: { spec: MediaSpec; found: FoundMedia }, base: string): string {
  const { spec, found } = media;
  const hasVideo = Boolean(found.webm || found.mp4);
  const ratio = `${story.width} / ${story.height}`;

  let inner: string;
  if (hasVideo) {
    const size = found.still ?? PLACEHOLDER_SIZE[spec.frame];
    const poster = found.still ? ` poster="${posterUrl(found.still, base)}"` : "";
    // Sources carry data-src: src/story.ts loads them (right away unless motion is reduced).
    const sources =
      (found.webm ? `<source data-src="${base}media/${found.webm}" type="video/webm">` : "") +
      (found.mp4 ? `<source data-src="${base}media/${found.mp4}" type="video/mp4">` : "");
    inner =
      `<div class="media media--mac" data-media="${spec.name}" data-state="real" data-kind="video" style="aspect-ratio: ${ratio}">` +
      `<video class="media-el" data-story-video muted playsinline preload="none" width="${size.width}" height="${size.height}"${poster}` +
      ` aria-label="${esc(spec.alt)}" aria-describedby="story-steps">${sources}</video></div>`;
  } else {
    inner = renderMedia(spec, found, base);
  }

  const steps = story.steps
    .map((step, i) => {
      const r = step.rect;
      const rect = [r.x / story.width, r.y / story.height, r.w / story.width, r.h / story.height].map(f4).join(" ");
      return (
        `<li class="story-step" data-step="${esc(step.id)}" data-start="${f4(step.start)}" data-end="${f4(step.end)}" data-rect="${rect}">` +
        `<button type="button" class="story-step-btn"${hasVideo ? "" : " disabled"}>` +
        `<span class="story-progress" aria-hidden="true"><i></i></span>` +
        `<span class="story-num" aria-hidden="true">${i + 1}</span><span class="story-label">${esc(step.label)}</span></button>` +
        `<p class="story-step-caption">${esc(storyCaption(step))}</p></li>`
      );
    })
    .join("");

  const toggle = hasVideo
    ? `<button type="button" class="story-toggle" data-story-toggle aria-label="Pause video">${PAUSE}</button>`
    : "";

  return (
    `<div class="story" data-story${hasVideo ? "" : ` data-story-static`} data-duration="${f4(story.duration)}" style="--story-ratio: ${ratio}">` +
    `<div class="story-stage" data-story-stage><div class="story-frame" data-story-frame>` +
    `<div class="window story-window">${inner}` +
    `<div class="story-spot" data-story-spot aria-hidden="true"></div></div>` +
    `<p class="story-caption" data-story-caption aria-hidden="true"></p></div>` +
    `<div class="story-bar"><ol class="story-steps" id="story-steps" aria-label="What the video shows, step by step">${steps}</ol>${toggle}</div>` +
    `</div></div>`
  );
}

/** Replaces `<glade-story></glade-story>` in the page with the hero's markup. */
export function injectStory(html: string, render: () => string): string {
  return html.replace(/<glade-story\s*><\/glade-story>/g, () => render());
}
