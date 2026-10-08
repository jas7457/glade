/**
 * Records a page as video (I-209): Chrome's screencast (CDP `Page.startScreencast`, JPEG frames at
 * the page's device pixels) resampled to a constant frame rate, then encoded to
 *   - WebM (VP9) with Playwright's own ffmpeg build (`npx playwright-core install ffmpeg`), and
 *   - MP4 (H.264) with AVFoundation through a small Swift program (macOS has no H.264 encoder in
 *     that ffmpeg build), plus a PNG poster = the first frame.
 *
 *   const rec = await startRecording(page);
 *   … drive the UI …
 *   await rec.stop({ out: "site/public/media", name: "hero", width: 1920, height: 1200 });
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FPS = 30;
const SWIFT_SRC = fileURLToPath(new URL("./encode-mp4.swift", import.meta.url));

/** Playwright's ffmpeg (has VP9 + MJPEG); throws with the install command when missing. */
export function ffmpegPath() {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  const dir = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("ffmpeg")).sort().at(-1) : null;
  const bin = dir ? join(root, dir, "ffmpeg-mac") : null;
  if (!bin || !existsSync(bin)) throw new Error("Playwright's ffmpeg is missing: run `pnpm --filter @glade/capture exec playwright-core install ffmpeg`");
  return bin;
}

/** The MP4 encoder, compiled once per source change into the temp folder. */
function mp4Encoder() {
  const bin = join(tmpdir(), `glade-encode-mp4-${Math.round(statSync(SWIFT_SRC).mtimeMs)}`);
  if (!existsSync(bin)) execFileSync("swiftc", ["-O", "-suppress-warnings", "-o", bin, SWIFT_SRC], { stdio: "inherit" });
  return bin;
}

/**
 * Starts recording `page`. Frames arrive only when something repaints; `stop` fills the gaps so
 * the video runs at a constant {@link FPS}.
 */
export async function startRecording(page, { quality = 92 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let started = 0;
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp ?? Date.now() / 1000, data });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  const viewport = page.viewportSize();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  // At most 2× (a 3× page is scaled down by Chrome), so frames stay a manageable size.
  const scale = Math.min(2, dpr);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, everyNthFrame: 1, maxWidth: viewport.width * scale, maxHeight: viewport.height * scale });
  started = Date.now() / 1000;
  return {
    /** Seconds since the recording started. */
    elapsed: () => Date.now() / 1000 - started,
    /**
     * Stops and encodes. `from`/`to` (seconds since start) trim the result; `poster` = the first
     * frame, or the one at `posterAt` (seconds since start; for the focus clip too). `focus` (CSS px of the viewport, `{ x, y, w, h }`, or a function returning it) also
     * writes `<name>-focus.*`: that region cropped at the recording's full resolution. Returns the
     * written paths with their sizes. `focusFrom`/`focusTo` (seconds since start) trim the focus
     * clip further, e.g. to the time a popover is open.
     */
    async stop({ out, name, width = 1920, height = 1200, from = 0, to = null, webmCrf = 31, mp4Bitrate = 7_000_000, focus = null, focusFrom = null, focusTo = null, posterAt = null }) {
      const end = Date.now() / 1000;
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      if (!frames.length) throw new Error(`${name}: no frames recorded`);
      const t0 = Math.max(frames[0].t, started) + from;
      const t1 = to === null ? end : Math.min(end, started + to);
      const dir = mkdtempSync(join(tmpdir(), `glade-capture-${name}-`));
      const count = Math.max(1, Math.round((t1 - t0) * FPS));
      if (process.env.GLADE_CAPTURE_DEBUG) console.log(`[capture] ${name}: ${frames.length} screencast frames for ${(t1 - t0).toFixed(1)} s`);
      let k = 0;
      const files = [];
      for (let i = 0; i < count; i++) {
        const t = t0 + i / FPS;
        while (k + 1 < frames.length && frames[k + 1].t <= t) k++;
        const file = join(dir, `${String(i).padStart(5, "0")}.jpg`);
        writeFileSync(file, Buffer.from(frames[k].data, "base64"));
        files.push(file);
      }
      mkdirSync(out, { recursive: true });
      const webm = join(out, `${name}.webm`);
      const mp4 = join(out, `${name}.mp4`);
      const poster = join(out, `${name}.png`);
      // Poster: the first frame (or the one at `posterAt`), at the video's size.
      const frameAt = (seconds) => Math.min(files.length - 1, Math.max(0, Math.round((seconds - (t0 - started)) * FPS)));
      const posterIndex = posterAt === null ? 0 : frameAt(posterAt);
      execFileSync("sips", ["-s", "format", "png", "-z", String(height), String(width), files[posterIndex], "--out", poster], { stdio: "ignore" });
      await encodeWebm(files, webm, { width, height, crf: webmCrf });
      encodeMp4(dir, [String(FPS), String(width), String(height), String(mp4Bitrate)], mp4);
      const written = [webm, mp4, poster];
      if (focus) {
        // The region in frame pixels (frames are the viewport at the screencast's scale), even sizes.
        const scale = frameWidth(files[0]) / viewport.width;
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        const crop = { x: even(focus.x * scale), y: even(focus.y * scale), w: even(focus.w * scale), h: even(focus.h * scale) };
        const base = join(out, `${name}-focus`);
        const vf = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
        // Its own span of frames (hard links in a folder of their own, for the MP4 encoder).
        const offset = t0 - started;
        const first = focusFrom === null ? 0 : Math.max(0, Math.round((focusFrom - offset) * FPS));
        const last = focusTo === null ? files.length : Math.min(files.length, Math.round((focusTo - offset) * FPS));
        const focusFiles = files.slice(first, Math.max(first + 1, last));
        const focusDir = join(dir, "focus");
        mkdirSync(focusDir);
        focusFiles.forEach((f, i) => linkSync(f, join(focusDir, `${String(i).padStart(5, "0")}.jpg`)));
        await encodeWebm(focusFiles, `${base}.webm`, { vf, crf: webmCrf - 3 });
        const focusPoster = posterAt === null ? focusFiles[0] : files[Math.max(first, Math.min(posterIndex, first + focusFiles.length - 1))];
        await encodeWebm([focusPoster], `${base}.png`, { vf, png: true });
        const bitrate = Math.round(((mp4Bitrate * crop.w * crop.h) / (width * height)) * 1.6);
        encodeMp4(focusDir, [String(FPS), String(crop.w), String(crop.h), String(bitrate)], `${base}.mp4`, [crop.x, crop.y, crop.w, crop.h].map(String));
        written.push(`${base}.webm`, `${base}.mp4`, `${base}.png`);
      }
      rmSync(dir, { recursive: true, force: true });
      return written.map((path) => ({ path, bytes: statSync(path).size }));
    },
  };
}

/**
 * MP4 via the Swift encoder. It writes into a scratch folder first: AVFoundation leaves `.sb-…`
 * temp files next to its output, which mustn't end up in the media folder.
 */
function encodeMp4(framesDir, args, out, crop = []) {
  const scratch = mkdtempSync(join(tmpdir(), "glade-capture-mp4-"));
  const file = join(scratch, "out.mp4");
  execFileSync(mp4Encoder(), [framesDir, ...args, file, ...crop], { stdio: "ignore" });
  copyFileSync(file, out);
  rmSync(scratch, { recursive: true, force: true });
}

/** Width of a JPEG frame (its SOF marker). */
function frameWidth(file) {
  const buf = readFileSync(file);
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) return 0;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return buf.readUInt16BE(i + 7);
    i += 2 + len;
  }
  return 0;
}

/** WebM (VP9) from JPEG frames; `vf` replaces the scale filter; `png` writes one PNG frame instead. */
function encodeWebm(files, out, { width, height, crf, vf, png = false }) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath(),
      [
        "-y", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0",
        "-vf", vf ?? `scale=${width}:${height}:flags=lanczos`,
        ...(png
          ? ["-frames:v", "1", "-c:v", "png", "-f", "image2", out]
          : ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", "-an", out]),
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    ff.on("error", reject);
    ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    (async () => {
      for (const f of files) {
        if (!ff.stdin.write(readFileSync(f))) await new Promise((r) => ff.stdin.once("drain", r));
      }
      ff.stdin.end();
    })().catch(reject);
  });
}
