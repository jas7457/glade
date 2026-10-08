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
PLAN.md I-209): `<name>.png` for images and video posters, `<name>.webm` + `<name>.mp4` for videos.
Anything missing shows a labelled placeholder in the capture's proportions; drop the file in and
the dev server reloads with the real one. The build makes WebP variants of every PNG and a
1200×630 `og.jpg` from the hero poster. To try other captures without touching `public/media/`:
`GLADE_SITE_MEDIA_DIR=/path/to/folder pnpm --filter @glade/site dev`.

## Design

- **Colour and type** come from the app's dark theme (`packages/app-core/src/styles.css`): window
  `#1e1e1e` on a `#161617` desktop, popovers `#3a3a3c`, the system blue `#0a84ff` for buttons, the
  sub-agent palette (teal, violet, amber…) for the small UI pieces, and the leaf green only in the
  icon. SF Pro (the system font) throughout, SF Mono only for code.
- **Layout:** the captures sit on the page as real windows (12px corners, macOS shadow and
  hairline); small pieces of the real UI (sub-agent rows, a tool row, ⌘K, the agent picker) are
  drawn in the app's own styles at its 13px size and float in front of them.
- **Motion** (`src/motion/`): four set pieces, the rest of the page still.
  1. Hero: the window assembles from slices of the hero capture flying in from different depths,
     then flattens as you scroll; the UI pieces float and lean toward the pointer.
  2. Sub-agents (pinned): scrolling drives three sub-agents working in parallel until the report
     lands.
  3. iPhone (pinned): the Mac steps back, the iPhone rises in front, the chat list slides out.
  4. Feature deck: sticky cards slide over each other; the covered card sinks back.

  Phones get short, unpinned versions. With reduced motion nothing moves (short fades only), videos
  don't autoplay, and the HTML is the finished, static layout.
