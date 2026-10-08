#!/usr/bin/env node
/**
 * Captures the website's screenshots and videos (I-209) from the demo sandbox
 * (`pnpm dev:agent --demo`: scripted pi / Claude Code / Codex chats about the made-up "Lantern"
 * repo; never the user's data) in headless Google Chrome, into `site/public/media/`.
 *
 *   pnpm capture                       everything (starts and removes its own sandbox)
 *   pnpm capture --only hero,agents    some items (names below)
 *   pnpm capture --sandbox demo        use a running `pnpm dev:agent --name demo --demo` (kept);
 *                                      live items change it, so use a fresh one for those
 *   pnpm capture --out /tmp/media      somewhere else
 *   pnpm capture --no-iphone           skip the simulator (iphone-* and the iPhone in `remote`)
 *   pnpm capture --no-iphone-build     reuse the last simulator build
 *
 * Stills are 2880×1800 PNGs (1440×900 CSS px at 2×, dark); videos 1920×1200 WebM + MP4 + poster
 * PNG. The iPhone shots (lib/iphone.mjs) pair the iOS simulator with the same sandbox; `remote`
 * runs after them so the Mac lists the iPhone. See site/public/media/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { launchBrowser, openWindow, parkMouse, settle } from "./lib/browser.mjs";
import { apiClient, REPO_ROOT, startDemoSandbox } from "./lib/sandbox.mjs";
import { startRecording } from "./lib/video.mjs";
import { captureIphone } from "./lib/iphone.mjs";
import { DEMO_PROMPTS, touchDevice } from "../../scripts/sandbox/demo/seed.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const out = opt("--out", join(REPO_ROOT, "site/public/media"));
const only = opt("--only")?.split(",") ?? null;
const attach = opt("--sandbox");
const noIphone = argv.includes("--no-iphone");
const iphoneBuild = !argv.includes("--no-iphone-build");
const log = (msg) => console.log(`[capture] ${msg}`);
const results = [];
/** Focus rects of this run (CSS px of the 1440×900 window), merged into focus.json. */
const focusRects = {};
/** Items that record video (2× page); stills render at 3× for sharp focus crops. */
const VIDEOS = new Set(["hero", "subagents", "search", "composer"]);
let sandbox;
let api;

/** Every item, in the order they run (live ones change the sandbox, so they come last). */
const ITEMS = {
  agents, "agents-settings": agentsSettings, "local-models": localModels, worktrees, bookmarks,
  search, composer, hero, terminal, subagents, iphone, remote,
};

// ---------------------------------------------------------------------------------------------

function attachSandbox(name) {
  const dir = join(process.env.GLADE_SANDBOX_ROOT || "/tmp/glade-sandbox", name);
  if (!existsSync(join(dir, "sandbox.json"))) throw new Error(`no sandbox named ${name}`);
  const state = JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8"));
  if (!state.demo) throw new Error(`sandbox ${name} isn't a demo sandbox (pnpm dev:agent --name ${name} --demo)`);
  return { dir, web: `http://127.0.0.1:${state.webPort}`, api: `http://127.0.0.1:${state.serverPort}/api`, demo: state.demo, stop: async () => {} };
}

const chat = (key) => sandbox.demo.chats[key];
const chatUrl = (key) => `${sandbox.web}/chats/${chat(key).workspaceId}`;

/**
 * Saves a still: the whole window (rendered at 3×, saved at 2880×1800) and, with `focus`, the
 * region that matters at full 3× sharpness as `<name>-focus.png` (its rect goes to focus.json).
 */
async function still(page, name, focus = null) {
  await parkMouse(page);
  await page.waitForTimeout(300);
  const path = join(out, `${name}.png`);
  const raw = join(tmpdir(), `glade-capture-${name}-${process.pid}.png`);
  await page.screenshot({ path: raw });
  execFileSync("sips", ["-z", "1800", "2880", raw, "--out", path], { stdio: "ignore" });
  rmSync(raw, { force: true });
  results.push({ path, bytes: statSync(path).size });
  if (focus) {
    const rect = typeof focus === "function" ? await focus() : await focus;
    const focusPath = join(out, `${name}-focus.png`);
    await page.screenshot({ path: focusPath, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } });
    results.push({ path: focusPath, bytes: statSync(focusPath).size });
    focusRects[name] = rect;
  }
}

/** Bounding box (CSS px) of the smallest element whose text contains all of `texts`. */
async function smallestWith(page, texts) {
  const box = await page.evaluate((texts) => {
    let best = null;
    for (const el of document.body.querySelectorAll("*")) {
      const text = el.textContent ?? "";
      if (!texts.every((t) => text.includes(t))) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (!best || r.width * r.height < best.width * best.height) best = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return best;
  }, texts);
  if (!box) throw new Error(`nothing contains ${texts.join(" + ")}`);
  return box;
}

/** Union of boxes (Playwright boxes, locators or {x,y,width,height}) plus padding, inside the viewport. */
async function region(page, parts, pad = 16, padY = pad) {
  const boxes = [];
  for (const part of parts) boxes.push(typeof part?.boundingBox === "function" ? await part.boundingBox() : await part);
  const valid = boxes.filter(Boolean);
  if (!valid.length) throw new Error("no region");
  const vp = page.viewportSize();
  const x0 = Math.max(0, Math.min(...valid.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...valid.map((b) => b.y)) - padY);
  const x1 = Math.min(vp.width, Math.max(...valid.map((b) => b.x + b.width)) + pad);
  const y1 = Math.min(vp.height, Math.max(...valid.map((b) => b.y + b.height)) + padY);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

async function open(page, url) {
  await page.goto(url);
  await settle(page, 1200);
}

/** Scrolls the transcript (wheel over the chat column). */
async function scrollChat(page, dy, x = 850, y = 400) {
  await page.mouse.move(x, y);
  for (let left = Math.abs(dy); left > 0; left -= 400) await page.mouse.wheel(0, Math.sign(dy) * Math.min(400, left));
  await page.waitForTimeout(700);
}

/** Types like a quick typist. */
async function type(page, text, delay = 14) {
  await page.keyboard.type(text, { delay });
}

/** Waits until no session of a workspace is working and its sub-agents are gone. */
async function waitIdle(workspaceId, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 500));
  while (Date.now() < until) {
    const detail = await api("GET", `/workspaces/${workspaceId}`);
    if (!detail.sessions.some((s) => s.status === "working" || s.kind === "subagent")) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`workspace ${workspaceId} still busy`);
}

// --- Stills ----------------------------------------------------------------------------------

/** The new-chat composer with its agent menu open: pi, Claude Code and Codex. */
async function agents(page) {
  await open(page, `${sandbox.web}/projects/${sandbox.demo.projectId}`);
  await page.getByRole("button", { name: "Agent: pi" }).click();
  await page.waitForTimeout(500);
  // Focus: the agent menu over the composer.
  await still(page, "agents", () =>
    region(page, [smallestWith(page, ["Claude Code", "Codex", "default"]), page.getByRole("button", { name: "Agent: pi" }), page.getByRole("button", { name: "Send" })], 20),
  );
}

/** Settings → Agents (all three installed), and a Claude Code chat. */
async function agentsSettings(page) {
  await open(page, `${sandbox.web}/settings/agent`);
  // Focus: the list of agents (pi, Claude Code, Codex).
  await still(page, "agents-settings", () => region(page, [smallestWith(page, ["Installed, used for new chats", "Claude Code", "codex"])], 20));
  await open(page, chatUrl("chart"));
  await still(page, "agents-claude");
}

async function localModels(page) {
  await open(page, `${sandbox.web}/settings/local-models`);
  // Focus: the model server's load bar and the models list.
  await still(page, "local-models", () => region(page, [smallestWith(page, ["llama-server ·", "Loaded"]), smallestWith(page, ["Qwen3.8-14B-Q5_K_M", "gemma-3-4b-it", "Used by"])], 20));
}

async function remote(page) {
  if (sandbox.demo.deviceToken) await touchDevice(sandbox.api, sandbox.demo.deviceToken);
  // The simulator reaches the sandbox over loopback; show the address the phone would have on the tailnet.
  const db = new DatabaseSync(join(sandbox.dir, "data", "glade.db"));
  db.exec("PRAGMA busy_timeout = 3000");
  try {
    db.prepare("UPDATE devices SET last_address = ? WHERE kind = 'phone' AND last_address = '127.0.0.1'").run("100.91.3.18");
  } finally {
    db.close();
  }
  await open(page, `${sandbox.web}/settings/remote`);
  // Focus: the Connect/Share buttons and the connected devices.
  await still(page, "remote", () => region(page, [smallestWith(page, ["Connections", "MacBook Air", "Found on your tailnet"])], 16));
}

/** The worktree chat with the changes panel open and two files' diffs expanded. */
async function worktrees(page) {
  await open(page, chatUrl("discord"));
  await page.getByRole("button", { name: /changed files/ }).click();
  await page.waitForTimeout(800);
  for (const file of ["discord.ts", "index.ts"]) {
    await page.getByText(file, { exact: true }).first().click();
    await page.waitForTimeout(500);
  }
  // Focus: the changes panel (files + the expanded index.ts diff), down to the start of discord.ts.
  await still(page, "worktrees", async () => {
    const panel = await smallestWith(page, ["Changes", "discord.ts", "Commit"]);
    return region(page, [{ x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, 560) }], 0);
  });
}

/** A bookmarked reply (the ribbon) and the header's bookmark list. */
async function bookmarks(page) {
  await open(page, chatUrl("audit"));
  await scrollChat(page, -600);
  await page.getByRole("button", { name: /^\d+ bookmarks?$/ }).first().click();
  await page.waitForTimeout(600);
  // Focus: the header's bookmark list and the ribboned reply.
  await still(page, "bookmarks", () =>
    region(page, [smallestWith(page, ["Bookmarks", "jump"]), page.getByRole("button", { name: /^Remove Bookmark: / }).first(), page.getByText(/^All three reviews are in/).first()], 16, 8),
  );
}

/** A terminal tab next to the chat, with a short session in the demo repo. */
async function terminal(page) {
  await open(page, chatUrl("retries"));
  await page.keyboard.press("Control+Backquote");
  await page.waitForTimeout(2500);
  for (const command of ["git log --oneline -6", "git status -s", "pnpm test"]) {
    await type(page, command, 30);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(command === "pnpm test" ? 2200 : 700);
  }
  // Focus: the terminal's used rows (and its tab).
  await still(page, "terminal", async () => {
    const rows = await page.evaluate(() => {
      const lines = [...document.querySelectorAll(".xterm-rows > div")].filter((d) => d.textContent?.trim());
      const last = lines.at(-1)?.getBoundingClientRect();
      const screen = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      return last && screen ? { x: screen.x, y: screen.y, width: Math.min(screen.width, 860), height: last.bottom - screen.y } : null;
    });
    return region(page, [rows, page.getByRole("tab", { name: /Terminal/ }).first()], 14, 2);
  });
}

/** iphone-list, iphone-chat, iphone-voice (+ iphone-voice-chat) in the simulator. */
async function iphone() {
  if (noIphone) return log("skipped (--no-iphone)");
  results.push(...(await captureIphone({ sandbox, out, prompts: DEMO_PROMPTS, build: iphoneBuild, log })));
}

// --- Videos ----------------------------------------------------------------------------------

/** The hero: a follow-up in a project chat; thinking, grouped tools, two sub-agents, the summary. */
async function hero(page) {
  await open(page, chatUrl("retries"));
  await page.getByRole("textbox").first().click();
  const rec = await startRecording(page);
  await page.waitForTimeout(400);
  await type(page, DEMO_PROMPTS.jitter, 6);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(13_500);
  results.push(...(await rec.stop({ out, name: "hero" })));
  await waitIdle(chat("retries").workspaceId);
}

/** A fresh chat that sends three sub-agents off in parallel; their cards and tabs update. */
async function subagents(page) {
  await open(page, `${sandbox.web}/projects/${sandbox.demo.projectId}`);
  await page.getByRole("textbox").first().click();
  await type(page, DEMO_PROMPTS.review, 4);
  const rec = await startRecording(page);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  // (No side pane: it closes when the agents finish, which would move the chat under the focus crop.)
  // Focus: the agents' cards and the space below them where the reports' summary lands (the
  // composer is too far down to include without a mostly empty middle).
  await page.getByText(/^Three agents are reviewing/).first().waitFor();
  const cards = await smallestWith(page, ["api-review", "sqlite-perf", "server-tests"]);
  const focus = await region(page, [{ ...cards, height: 470 }], 16);
  await page.waitForTimeout(10_700);
  results.push(...(await rec.stop({ out, name: "subagents", focus })));
  focusRects.subagents = focus;
}

/** ⌘K: find a chat and a bookmark, then jump to the bookmarked message. */
async function search(page) {
  await open(page, chatUrl("region"));
  const rec = await startRecording(page);
  await page.waitForTimeout(600);
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(500);
  await type(page, "backoff", 120);
  await page.waitForTimeout(1600);
  // Focus: the palette with its results.
  const focus = await region(page, [page.getByRole("dialog").first()], 24);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  results.push(...(await rec.stop({ out, name: "search", focus })));
  focusRects.search = focus;
}

/** The Send button changing as ⌘ and ⌥ are held while the agent works (steer, follow-up, ask aside). */
async function composer(page) {
  await open(page, chatUrl("audit"));
  await page.getByRole("textbox").first().click();
  await type(page, DEMO_PROMPTS.overlap, 0);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await type(page, "Also cover a check that's slower than its interval in the test", 0);
  // Focus: the right end of the composer, where the Send button changes.
  // Focus: the composer, where the Send button (bottom right) changes.
  const focus = await region(page, [page.getByRole("textbox").first(), page.getByRole("button", { name: "Attach files" }).first(), page.getByRole("button", { name: /Send|Steer|Follow-up|Queue|Ask/ }).last()], 14);
  const rec = await startRecording(page);
  await page.waitForTimeout(1000);
  await page.keyboard.down("Meta");
  await page.waitForTimeout(1500);
  await page.keyboard.up("Meta");
  await page.waitForTimeout(800);
  await page.keyboard.down("Alt");
  await page.waitForTimeout(1500);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(900);
  results.push(...(await rec.stop({ out, name: "composer", focus })));
  focusRects.composer = focus;
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await waitIdle(chat("audit").workspaceId);
}

// ---------------------------------------------------------------------------------------------

sandbox = attach ? attachSandbox(attach) : await startDemoSandbox({ log });
api = apiClient(sandbox);
const browser = await launchBrowser();
try {
  for (const [name, run] of Object.entries(ITEMS)) {
    if (only && !only.includes(name)) continue;
    log(`${name}…`);
    const { context, page } = await openWindow(browser, { scale: VIDEOS.has(name) ? 2 : 3 });
    try {
      await run(page);
    } catch (err) {
      log(`${name} failed: ${err.stack ?? err}`);
      process.exitCode = 1;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  if (!attach) await sandbox.stop();
}
if (Object.keys(focusRects).length) {
  const file = join(out, "focus.json");
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const merged = { ...previous, ...focusRects };
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]])), null, 2) + "\n");
}
for (const r of results) log(`${r.path.replace(REPO_ROOT, "")}  ${(r.bytes / 1024 / 1024).toFixed(2)} MB`);
