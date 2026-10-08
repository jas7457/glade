# Glade website

The public site at <https://jas7457.github.io/glade/> (PLAN.md I-209): one static page, built with
Vite + TypeScript, motion with GSAP + ScrollTrigger. Deployed by `.github/workflows/pages.yml` on
every push to `main` that touches `site/`.

```bash
pnpm --filter @glade/site dev        # http://127.0.0.1:5417/glade/
pnpm --filter @glade/site build      # → site/dist (WebP variants + Open Graph image made here)
pnpm --filter @glade/site preview    # serve the build: http://127.0.0.1:5418/glade/
pnpm --filter @glade/site test       # media contract tests
```

## Media

Screenshots and videos live in `public/media/` with the names in `build/media.ts` (the contract in
PLAN.md I-209; how they're made is in `public/media/README.md`): `<name>.png` for images and video
posters, `<name>.webm` + `<name>.mp4` for videos, `<name>-focus.*` for the focus versions (just the
part that matters, at 3×), and `focus.json` with each focus rectangle in the full capture's CSS px
(the 1440×900 window). Anything missing falls back gracefully: without a focus asset (or its
rectangle) a feature shows the whole window; without either, a labelled placeholder in the
capture's proportions. Drop the file in and the dev server reloads with the real one. The build
makes WebP variants of every PNG and a 1200×630 `og.jpg` from the hero poster. To try other
captures without touching `public/media/`: `GLADE_SITE_MEDIA_DIR=/path/to/folder pnpm --filter @glade/site dev`.

The hero is **`hero-story`** (`.webm`/`.mp4`/`.png` + `hero-story.json`: the steps, each with its
time range, label, optional caption and the region of the window that matters, in the capture's
CSS px; `build/story.ts`). Until those files exist, the hero uses a stand-in, the older `hero`
recording with the hand-written steps in `dev/hero-story.sample.json`, and it switches to the real
ones as soon as both the JSON and a video land (a build without them warns).

Loading: the hero's poster and video load first; every other picture is `loading="lazy"`, videos
load their sources only when they come near the viewport (`src/videos.ts`), and the window behind a
focus asset is always a mid-size still (a video's poster), never a second video.

## Design

- **Colour and type** come from the app's dark theme (`packages/app-core/src/styles.css`): window
  `#1e1e1e` on a `#161617` desktop, popovers `#3a3a3c` (the hero's captions), the system blue `#0a84ff` for buttons and the
  spotlight's ring, and the leaf green only in the icon. SF Pro (the system font) throughout, SF Mono only for code.
- **Layout:** every picture fits the visible viewport below the fixed header (sized by height as
  well as width), and each feature's text is on screen with it.
  - **Hero:** the headline, one line and the buttons, then the `hero-story` recording filling the
    rest of the first screen, with its steps under it (`<glade-story>`, rendered by
    `build/story.ts`).
  - **Features:** every feature is a **panel** (`[data-panel]` in `index.html`) one screen tall:
    the text on the left, the stage on the right, both centred (stacked on phones). A stage is a
    **focus stage** (`<glade-focus>`, rendered by `build/media.ts`): the focus asset large in
    front, the whole window behind it, dimmed, tilted back, the region outlined, so you see where
    it lives. `focusLayout()` places the layers from `focus.json`; sections can add extra layers
    (the Settings → Agents card, the phones; `--extra` makes room for them). The stage's width is
    worked out from the height it may take (`--stage-max-h`).
- **Motion:**
  1. Hero (`src/story.ts`): the recording plays while most of it is on screen. For the current
     step, everything outside its region is dimmed (the spotlight glides from region to region)
     and a short caption sits beside it (under the video on phones). The steps below follow
     playback and seek when pressed; there's a pause button; at the end the last frame holds for
     a moment and it starts over.
  2. Feature panels (`src/motion/focus.ts`): on desktop each panel pins under the header while
     you scroll through it, and the motion is scrubbed inside that pinned stretch, so it starts
     and ends with the text and the whole stage on screen. The window starts flat with its region
     outlined; the region lifts out of it and flies forward to the focus asset's place while the
     window steps back and dims, then the sharp focus asset cross-fades in and the extra layers
     land. The voice panel's phones rise and turn in the same way.

  On phones nothing pins: each stage fades and rises once it's entirely on screen. With reduced
  motion nothing moves and nothing autoplays: the hero shows its poster with the steps and their
  captions as text (a step shows that moment, the play button plays it), and the panels are the
  finished, static layout.
