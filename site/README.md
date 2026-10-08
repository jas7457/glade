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

Loading: the hero poster and video load first; every other picture is `loading="lazy"`, videos
load their sources only when they come near the viewport (`src/videos.ts`), and the window behind a
focus asset is always a mid-size still (a video's poster), never a second video.

## Design

- **Colour and type** come from the app's dark theme (`packages/app-core/src/styles.css`): window
  `#1e1e1e` on a `#161617` desktop, popovers `#3a3a3c`, the system blue `#0a84ff` for buttons, the
  sub-agent palette (teal, violet, amber…) for the small UI pieces, and the leaf green only in the
  icon. SF Pro (the system font) throughout, SF Mono only for code.
- **Layout:** the hero shows the whole window, large, with small pieces of the real UI floating in
  front of it. Every feature after it is a **focus stage** (`<glade-focus>` in `index.html`,
  rendered by `build/media.ts`): the focus asset large in front (sized to read at about the app's
  own size on a desktop), the whole window behind it, dimmed, tilted back, the region outlined,
  so you see where it lives. `focusLayout()` places the layers from `focus.json`; sections can add
  extra layers (the Settings → Agents card, the phones).
- **Motion** (`src/motion/`):
  1. Hero: the window assembles from slices of the hero capture flying in from different depths,
     then flattens as you scroll; the UI pieces float and lean toward the pointer.
  2. Focus stages (`focus.ts`): scrolling a stage in, the window starts flat with its region
     outlined; the region lifts out of it and flies forward to the focus asset's place while the
     window steps back and dims, then the sharp focus asset cross-fades in. The phones in the
     iPhone and voice sections rise in at their own depths (`remote.ts`).

  On phones the stages and phones just rise in once. With reduced motion nothing moves (short fades only), videos
  don't autoplay, and the HTML is the finished, static layout.
