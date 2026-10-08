/**
 * Videos (markup from build/media.ts): sources load only when a video comes near the viewport
 * (`data-src` → `src`), play while at least a third of it is visible and pause otherwise. Every
 * video gets a pause/play button. With reduced motion nothing autoplays: the poster shows with a
 * play button. (The hero's video has its own player: src/story.ts.)
 */
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;

interface VideoState {
  loaded: boolean;
  visible: boolean;
  /** The user paused it (or reduced motion and they haven't pressed play yet). */
  userPaused: boolean;
}

const states = new WeakMap<HTMLVideoElement, VideoState>();

function load(video: HTMLVideoElement, state: VideoState): void {
  if (state.loaded) return;
  state.loaded = true;
  for (const source of video.querySelectorAll<HTMLSourceElement>("source[data-src]")) {
    source.src = source.dataset.src ?? "";
    source.removeAttribute("data-src");
  }
  video.preload = "auto";
  video.load();
}

function sync(video: HTMLVideoElement): void {
  const state = states.get(video);
  if (!state) return;
  const shouldPlay = state.visible && !state.userPaused;
  if (shouldPlay) {
    load(video, state);
    void video.play().catch(() => {
      // Autoplay refused (e.g. Low Power Mode): show the play button instead.
      state.userPaused = true;
      render(video);
    });
  } else if (!video.paused) {
    video.pause();
  }
  render(video);
}

function render(video: HTMLVideoElement): void {
  const state = states.get(video);
  const slot = video.closest<HTMLElement>(".media");
  const button = slot?.querySelector<HTMLButtonElement>(".video-toggle");
  if (!state || !slot || !button) return;
  slot.dataset.paused = String(state.userPaused);
  button.innerHTML = state.userPaused ? PLAY : PAUSE;
  button.setAttribute("aria-label", state.userPaused ? "Play video" : "Pause video");
}

export function initVideos(): void {
  const videos = [...document.querySelectorAll<HTMLVideoElement>("video[data-video]")];
  if (videos.length === 0) return;

  const near = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target as HTMLVideoElement;
        const state = states.get(video);
        if (entry.isIntersecting && state && !state.userPaused) load(video, state);
      }
    },
    { rootMargin: "400px 0px" },
  );
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target as HTMLVideoElement;
        const state = states.get(video);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        sync(video);
      }
    },
    { threshold: 0.33 },
  );

  for (const video of videos) {
    const state: VideoState = { loaded: false, visible: false, userPaused: reduceMotion() };
    states.set(video, state);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "video-toggle";
    button.addEventListener("click", () => {
      state.userPaused = !state.userPaused;
      sync(video);
    });
    video.closest(".media")?.append(button);
    render(video);
    if (video.hasAttribute("data-eager") && !state.userPaused) load(video, state);
    near.observe(video);
    seen.observe(video);
  }
}
