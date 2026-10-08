/**
 * Vite plugin for the site's media (see `media.ts`): looks in `public/media/` for each capture
 * and `focus.json`, expands `<glade-focus>` stages and `<glade-media>` slots in index.html into real
 * `<picture>`/`<video>` markup (or placeholders), and, in builds,
 * emits WebP variants of every still plus a 1200×630 Open Graph image cut from the hero poster.
 *
 * The dev server reloads the page when a file appears in or leaves `public/media/`, so the
 * placeholders swap for the real captures as soon as they land. Variants are cached in
 * `node_modules/.cache/glade-media` (keyed by size + mtime), so rebuilds are quick.
 *
 * `GLADE_SITE_MEDIA_DIR=/some/dir pnpm dev` previews the page with media from another folder
 * (served at `media/` by the dev server, copied into the build), to try captures without touching
 * public/media.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import {
  MEDIA,
  findFiles,
  focusOptions,
  injectFocus,
  injectMedia,
  mediaSpec,
  parseFocusJson,
  renderFocus,
  renderMedia,
  variantWidths,
  type FocusRect,
  type FoundImage,
  type FoundMedia,
} from "./media.ts";
import { injectStory, parseStory, renderStory, type Story } from "./story.ts";

type Sharp = typeof import("sharp").default;

/** The deployed site's absolute URL (Open Graph needs absolute image URLs). */
const SITE_URL = "https://jas7457.github.io/glade/";

async function loadSharp(): Promise<Sharp | undefined> {
  try {
    return (await import("sharp")).default;
  } catch {
    console.warn("[media] sharp isn't available: serving the original PNGs without WebP variants");
    return undefined;
  }
}

export function mediaPlugin(root: string): Plugin {
  const override = process.env.GLADE_SITE_MEDIA_DIR;
  const mediaDir = override ? resolve(override) : join(root, "public", "media");
  const cacheDir = join(root, "node_modules", ".cache", "glade-media");
  let base = "/";
  let isBuild = false;
  let sharp: Sharp | undefined;
  /** Files emitted into the bundle at build time: name inside media/ → bytes. */
  const emitted = new Map<string, Buffer>();
  let found = new Map<string, FoundMedia>();
  let focusRects: Record<string, FocusRect> = {};
  let ogImage: string | undefined;
  /** The hero's story: the real `hero-story` recording, or the stand-in (`hero` + the sample steps). */
  let story: { data: Story; media: string } | undefined;
  const sampleStory = join(root, "dev", "hero-story.sample.json");

  const listing = () => (existsSync(mediaDir) ? readdirSync(mediaDir) : []);

  /** Cached sharp output for `file` with `key` (the variant), recomputed when the source changes. */
  async function cached(file: string, key: string, make: () => Promise<Buffer>): Promise<Buffer> {
    const st = statSync(join(mediaDir, file));
    const path = join(cacheDir, `${file}.${st.size}-${Math.round(st.mtimeMs)}.${key}`);
    if (existsSync(path)) return readFileSync(path);
    const out = await make();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, out);
    return out;
  }

  async function scan(): Promise<void> {
    const files = listing();
    const focusFile = join(mediaDir, "focus.json");
    focusRects = existsSync(focusFile) ? parseFocusJson(readFileSync(focusFile, "utf8")) : {};
    const next = new Map<string, FoundMedia>();
    emitted.clear();
    ogImage = undefined;
    for (const spec of MEDIA) {
      const f = findFiles(spec.name, files);
      const media: FoundMedia = { webm: f.webm, mp4: f.mp4 };
      if (f.still) {
        const path = join(mediaDir, f.still);
        let width = 0;
        let height = 0;
        if (sharp) {
          const meta = await sharp(path).metadata();
          width = meta.width ?? 0;
          height = meta.height ?? 0;
        } else if (f.still.endsWith(".png")) {
          const buf = readFileSync(path);
          width = buf.readUInt32BE(16);
          height = buf.readUInt32BE(20);
        }
        const still: FoundImage = { file: f.still, width, height, variants: [] };
        if (isBuild && sharp && width > 0) {
          const s = sharp;
          for (const w of variantWidths(spec.frame, width)) {
            const file = `opt/${spec.name}-${w}.webp`;
            const buf = await cached(f.still, `${w}.webp`, () =>
              s(path).resize({ width: w }).webp({ quality: 82, effort: 5 }).toBuffer(),
            );
            emitted.set(file, buf);
            still.variants.push({ file, width: w });
          }
          if (spec.name === "hero") {
            const og = await cached(f.still, "og.jpg", () =>
              s(path).resize({ width: 1200, height: 630, fit: "cover", position: "top" }).jpeg({ quality: 84 }).toBuffer(),
            );
            emitted.set("opt/og.jpg", og);
            ogImage = "media/opt/og.jpg";
          }
        }
        if (width > 0) media.still = still;
      }
      next.set(spec.name, media);
    }
    found = next;

    const storyFile = join(mediaDir, "hero-story.json");
    const real = existsSync(storyFile) ? parseStory(readFileSync(storyFile, "utf8")) : undefined;
    const realVideo = next.get("hero-story");
    if (real && (realVideo?.webm || realVideo?.mp4)) {
      story = { data: real, media: "hero-story" };
    } else {
      const sample = existsSync(sampleStory) ? parseStory(readFileSync(sampleStory, "utf8")) : undefined;
      story = sample ? { data: sample, media: "hero" } : undefined;
      if (isBuild) console.warn("[media] no hero-story.json + video in media/: the hero uses the stand-in (hero + dev/hero-story.sample.json)");
    }
  }

  function metaTags(): string {
    const image = ogImage ?? "apple-touch-icon.png";
    const card = ogImage ? "summary_large_image" : "summary";
    return (
      `<meta property="og:image" content="${SITE_URL}${image}">\n    ` +
      (ogImage ? `<meta property="og:image:width" content="1200">\n    <meta property="og:image:height" content="630">\n    ` : "") +
      `<meta name="twitter:card" content="${card}">`
    );
  }

  return {
    name: "glade-media",
    async configResolved(config) {
      base = config.base;
      isBuild = config.command === "build";
      sharp = await loadSharp();
    },
    async buildStart() {
      await scan();
    },
    configureServer(server) {
      if (override) {
        const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".webm": "video/webm", ".mp4": "video/mp4" };
        server.middlewares.use(`${base}media/`, (req, res, next) => {
          const file = join(mediaDir, decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(/^\/+/, ""));
          if (!file.startsWith(mediaDir) || !existsSync(file)) return next();
          res.setHeader("Content-Type", types[extname(file).toLowerCase()] ?? "application/octet-stream");
          res.end(readFileSync(file));
        });
      }
      server.watcher.add([mediaDir, sampleStory]);
      const onChange = async (path: string) => {
        if (!path.startsWith(mediaDir) && path !== sampleStory) return;
        await scan();
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
      server.watcher.on("change", onChange);
    },
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        if (!isBuild) await scan();
        const source = (name: string) => {
          const spec = mediaSpec(name);
          return spec ? { spec, found: found.get(name) ?? {} } : undefined;
        };
        const withStory = injectStory(html, () => {
          if (!story) return renderMedia(mediaSpec("hero")!, found.get("hero") ?? {}, base);
          return renderStory(story.data, { spec: mediaSpec(story.media)!, found: found.get(story.media) ?? {} }, base);
        });
        const staged = injectFocus(withStory, (tag) => {
          const full = source(tag.name);
          if (!full) throw new Error(`[media] unknown media "${tag.name}" in <glade-focus>`);
          return renderFocus(tag.name, { full, focus: source(`${tag.name}-focus`), rect: focusRects[tag.name] }, focusOptions(tag), base);
        });
        const out = injectMedia(staged, (name) => {
          const spec = mediaSpec(name);
          if (!spec) throw new Error(`[media] unknown media "${name}" in index.html`);
          return renderMedia(spec, found.get(name) ?? {}, base);
        });
        return out.replace("<!-- glade:og -->", metaTags());
      },
    },
    generateBundle() {
      if (override) for (const file of listing()) this.emitFile({ type: "asset", fileName: `media/${file}`, source: readFileSync(join(mediaDir, file)) });
      for (const [file, source] of emitted) this.emitFile({ type: "asset", fileName: `media/${file}`, source });
    },
  };
}
