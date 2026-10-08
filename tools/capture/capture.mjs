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
 * PNG; `hero-story` 2880×1800 plus hero-story.json (its steps' times and rects). The iPhone shots (lib/iphone.mjs) pair the iOS simulator with the same sandbox; `remote`
 * runs after them so the Mac lists the iPhone. See site/public/media/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { launchBrowser, openWindow, parkMouse, settle, VIEWPORT } from "./lib/browser.mjs";
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
const VIDEOS = new Set(["hero", "subagents", "subagent-tabs", "search", "composer", "hero-story"]);
let sandbox;
let api;

/** Every item, in the order they run (live ones change the sandbox, so they come last). */
const ITEMS = {
  agents, "agents-settings": agentsSettings, "local-models": localModels, worktrees, bookmarks,
  search, composer, hero, terminal, subagents, "subagent-tabs": subagentTabs, iphone, remote, "hero-story": heroStory,
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
  // Focus: the top of the changes panel (the files and the start of index.ts's diff), no taller
  // than 16:10 so it fits next to the site's text.
  await still(page, "worktrees", async () => {
    const panel = await smallestWith(page, ["Changes", "discord.ts", "Commit"]);
    return region(page, [{ x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, Math.round(panel.width / 1.6)) }], 0);
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
    const r = await region(page, [rows, page.getByRole("tab", { name: /Terminal/ }).first()], 14, 2);
    // Start right of the sidebar's edge and below the header's separator (no dark strips).
    const tabs = await page.getByRole("tablist").first().boundingBox();
    const left = Math.ceil(tabs.x) + 1;
    const top = Math.ceil(tabs.y);
    return { x: Math.max(r.x, left), y: Math.max(r.y, top), w: r.w - Math.max(0, left - r.x), h: r.h - Math.max(0, top - r.y) };
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
  // Focus: the agents' cards and the space below them where the reports' summary lands, about
  // 16:10 (the composer is too far down to include without a mostly empty middle).
  await page.getByText(/^Three agents are reviewing/).first().waitFor();
  const cards = await smallestWith(page, ["api-review", "sqlite-perf", "server-tests"]);
  const focus = await region(page, [{ ...cards, height: 440 }], 16);
  await page.waitForTimeout(10_700);
  results.push(...(await rec.stop({ out, name: "subagents", focus })));
  focusRects.subagents = focus;
}

/**
 * A sub-agent's own tab (I-212): a new chat sends three sub-agents off (Docker image, health route,
 * deployment guide); the Docker one's card opens its tab in the side pane (its task, thinking and
 * tool calls as they happen); a message typed in its composer steers it, and it answers and
 * adjusts its work. The chat is deleted afterwards (the iPhone list and the hero story don't show
 * it). Focus: the top of the side pane, its tabs and the conversation, from when the pane opens.
 */
async function subagentTabs(page) {
  await open(page, `${sandbox.web}/projects/${sandbox.demo.projectId}`);
  await page.getByRole("textbox").first().click();
  await type(page, DEMO_PROMPTS.deploy, 4);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chats\//, { timeout: 10_000 });
  const workspaceId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  // A wide side pane (2/3 of the content area), so the sub-agent's conversation reads large.
  await api("PATCH", `/workspaces/${workspaceId}`, { layout: { subagentPaneSize: 0.66 } });
  const openDocker = page.locator("[data-agent-color]").first().getByRole("button", { name: /^Open / });
  await openDocker.waitFor({ timeout: 10_000 });
  await parkMouse(page);
  const rec = await startRecording(page);
  await page.waitForTimeout(1200);
  await openDocker.click();
  await parkMouse(page);
  const pane = page.locator('[data-testid="transcript-scroll"]').nth(1);
  await pane.waitFor();
  const focusFrom = rec.elapsed() + 0.25;
  // The pane keeps its latest lines in the focus region (its top): content is pinned that far above
  // the composer, as if the conversation were already long; the full window looks the same.
  await pane.evaluate((el) => {
    const content = [...el.querySelectorAll("div")].find((d) => d.classList.contains("pt-6") && d.classList.contains("pb-8"));
    if (content) content.style.paddingBottom = "340px";
  });
  // The writes and the build, opened as they come in.
  const groups = pane.locator(".tool-group");
  await groups.nth(1).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(200);
  await groups.nth(1).locator("button").first().click();
  // Meanwhile: ask it to keep the database on a volume, typed in its own composer (it gets the
  // message once the build is done, like a real agent's steer).
  await page.waitForTimeout(500);
  await page.getByRole("textbox").last().click();
  await parkMouse(page);
  await typeLikeAPerson(page, DEMO_PROMPTS.deployVolume);
  await page.waitForTimeout(350);
  await page.keyboard.press("Enter");
  // Its answer: the thinking (opened), a short reply, then the adjusted work (opened).
  const thoughts = await pane.locator(".thinking").count();
  await pane.getByText(DEMO_PROMPTS.deployVolume).waitFor({ timeout: 15_000 });
  const thinking = pane.locator(".thinking").nth(thoughts);
  await thinking.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(150);
  await thinking.locator("button").first().click();
  await parkMouse(page);
  await groups.nth(2).waitFor({ timeout: 15_000 });
  // Posters (the site's still of the window, and the focus clip's): the message, the answer, the new work.
  const posterAt = rec.elapsed() + 0.7;
  await page.waitForTimeout(200);
  await groups.nth(2).locator("button").first().click();
  await parkMouse(page);
  // Until it has reported (its tab stays open: you typed in it), and a moment on its result.
  await waitSubagentsDone(workspaceId);
  await page.waitForTimeout(2000);
  const focus = await focusOfPane(page, pane);
  results.push(...(await rec.stop({ out, name: "subagent-tabs", focus, focusFrom, posterAt })));
  focusRects["subagent-tabs"] = focus;
  await api("DELETE", `/workspaces/${workspaceId}`);
}

/** Waits until none of a workspace's sub-agents is working (they may stay open). */
async function waitSubagentsDone(workspaceId, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const detail = await api("GET", `/workspaces/${workspaceId}`);
    if (!detail.sessions.some((s) => s.kind === "subagent" && s.status === "working")) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`workspace ${workspaceId}: sub-agents still working`);
}

/** The side pane from its tabs down, 16:10 (the tallest a focus region gets). */
async function focusOfPane(page, pane) {
  const box = await pane.boundingBox();
  const tabs = await page.getByRole("tablist").last().boundingBox();
  const x = Math.round(box.x) + 1;
  const y = Math.round(tabs.y);
  const w = VIEWPORT.width - x;
  return { x, y, w, h: Math.round(w / 1.6) };
}

/** Human typing: ~40 ms a key, a little longer after spaces and punctuation, the same every run. */
async function typeLikeAPerson(page, text) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const ch of text) {
    await page.keyboard.type(ch);
    const pause = 20 + rand() * 26 + (ch === " " ? 16 : 0) + (/[.,?]/.test(ch) ? 110 : 0);
    await page.waitForTimeout(pause);
  }
}

/**
 * The window tidied for the hero story: three project chats and the two standalone ones (the
 * other chats deleted: this runs last, in a sandbox that's thrown away), and the repo's
 * outstanding changes committed so the header's changes count starts from nothing.
 */
async function tidyForStory() {
  const keep = new Set(["retries", "audit", "chart", "percentiles", "abort"].map((k) => chat(k).workspaceId));
  const all = await api("GET", "/workspaces");
  for (const w of all) {
    if (keep.has(w.id)) continue;
    await api("DELETE", `/workspaces/${w.id}${w.worktree ? "?worktree=discard" : ""}`);
  }
  await api("PUT", "/workspaces/order", { projectId: sandbox.demo.projectId, folderId: null, ids: ["retries", "audit", "chart"].map((k) => chat(k).workspaceId) });
  const git = (...args) => execFileSync("git", args, { cwd: sandbox.demo.repo, stdio: "ignore" });
  git("add", "-A");
  try {
    git("-c", "user.name=Lantern Maintainers", "-c", "user.email=maintainers@lantern.invalid", "commit", "-q", "-m", "Jitter, scheduler and server tests");
  } catch {
    // nothing to commit
  }
}

/**
 * The hero story (2× page, 1440×900): an empty New Chat (agent menu opened briefly), a question
 * typed at a human pace, the chat appearing in the sidebar (quick title, then the generated one),
 * the reply working (thinking, a tool group opened as its calls come in, an edit's diff) and the
 * finished answer. Writes `hero-story.{webm,mp4,png}` at 2880×1800 and `hero-story.json`: each
 * step's time span (seconds into the video) and the rect it's about (CSS px, measured in the page).
 */
async function heroStory(page) {
  await tidyForStory();
  await open(page, `${sandbox.web}/projects/${sandbox.demo.projectId}`);
  await parkMouse(page);
  const steps = [];
  const agentButton = page.getByRole("button", { name: "Agent: pi" });
  const textbox = page.getByRole("textbox").first();
  const composerParts = () => [textbox, page.getByRole("button", { name: "Attach files" }).first(), page.getByRole("button", { name: "Send" }).first()];
  const rec = await startRecording(page);
  const at = () => Math.round(rec.elapsed() * 100) / 100;

  // 1. The empty New Chat: the agent menu (pi, Claude Code, Codex) and the model/thinking pickers.
  await page.waitForTimeout(1300);
  await agentButton.click();
  await page.waitForTimeout(350);
  const menu = await smallestWith(page, ["Claude Code", "Codex"]);
  const agentRect = await region(page, [agentButton, menu, ...composerParts()], 12);
  await page.waitForTimeout(1300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
  steps.push({ id: "agent", label: "Pick an agent", caption: "A new chat: pick the agent (pi, Claude Code or Codex), its model and how hard it thinks.", start: 0, end: at(), rect: agentRect });

  // 2. The question, typed.
  const askStart = at();
  await textbox.click();
  await parkMouse(page);
  const askRect = await region(page, composerParts(), 12);
  await page.waitForTimeout(250);
  await typeLikeAPerson(page, DEMO_PROMPTS.prune);
  await page.waitForTimeout(500);
  steps.push({ id: "ask", label: "Ask", caption: "Ask in your own words, about your own project.", start: askStart, end: at(), rect: askRect });

  // 3. Sent: the chat shows up at the top of the project, then gets its generated title.
  const sidebarStart = at();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chats\//, { timeout: 10_000 });
  const workspaceId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  const row = page.locator(`[data-chat-id="${workspaceId}"]`).first();
  // The reply's thinking and first tool group, opened as they come in (the scenario waits a
  // moment before thinking, while the title is generated).
  const transcript = page.locator('[data-testid="transcript-scroll"]');
  const thinking = transcript.locator(".thinking button").first();
  const openThinking = thinking.waitFor({ timeout: 15_000 }).then(() => thinking.click());
  const group = transcript.locator(".tool-group").first();
  const openGroup = group.waitFor({ timeout: 15_000 }).then(() => group.locator("button").first().click());
  await row.waitFor();
  await row.getByText("Speed up pruning old results").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  steps.push({ id: "sidebar", label: "It shows up in the sidebar", caption: "The chat appears at the top of its project and names itself.", start: sidebarStart, end: at(), rect: await region(page, [row], 2) });

  // 4. Working: thinking, the tool group, the edit (opened to show its diff), the checks.
  const workStart = at();
  await openThinking;
  await openGroup;
  await parkMouse(page);
  // The edit is the turn's only call outside a group.
  const editRow = transcript.locator(".tool-call:not(.tool-group .tool-call)").first();
  await editRow.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(250);
  await editRow.locator("button").first().click();
  await parkMouse(page);
  const summary = page.getByText(/^Fixed\. The hourly cleanup/).first();
  await summary.waitFor({ timeout: 30_000 });
  const turn = await transcript.boundingBox();
  const column = await page.locator('[data-testid="transcript-scroll"] [data-role="assistant"]').first().boundingBox();
  steps.push({ id: "work", label: "Watch it work", caption: "It thinks, reads, checks the query plan and edits the file, each step as it happens.", start: workStart, end: at(), rect: await region(page, [{ x: column.x, y: turn.y, width: column.width, height: turn.height }], 12, 0) });

  // 5. Done: the short summary (and the changes count in the header).
  const doneStart = at();
  await waitIdle(workspaceId, 30_000);
  await page.waitForTimeout(2600);
  const answer = await smallestWith(page, ["Fixed. The hourly cleanup", "Tests pass."]);
  steps.push({ id: "done", label: "Done", caption: "A short summary of what changed; the diff is one click away.", start: doneStart, end: at(), rect: await region(page, [answer], 12) });

  const duration = at();
  results.push(...(await rec.stop({ out, name: "hero-story", width: 2880, height: 1800, mp4Bitrate: 12_000_000 })));
  const file = join(out, "hero-story.json");
  writeFileSync(file, JSON.stringify({ width: VIEWPORT.width, height: VIEWPORT.height, duration, steps }, null, 2) + "\n");
  results.push({ path: file, bytes: statSync(file).size });
}

/** ⌘K: find a chat and a bookmark, then jump to the bookmarked message. */
async function search(page) {
  await open(page, chatUrl("region"));
  // Focus: the palette's largest extent while the focus clip runs (it changes size as results
  // come in), tracked every frame.
  await page.evaluate(() => {
    const track = () => {
      const r = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
      if (r && r.width && r.height) {
        const u = window.__paletteBox;
        window.__paletteBox = u
          ? { x: Math.min(u.x, r.x), y: Math.min(u.y, r.y), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }
          : { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }
      requestAnimationFrame(track);
    };
    track();
  });
  const rec = await startRecording(page);
  await page.waitForTimeout(600);
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(500);
  // The focus clip starts once the query has narrowed the list (the empty palette lists
  // everything and is twice as tall) and ends before the palette closes.
  await type(page, "back", 120);
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__paletteBox = null));
  const focusFrom = rec.elapsed();
  await type(page, "off", 120);
  await page.waitForTimeout(1600);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(900);
  const focusTo = rec.elapsed();
  const box = await page.evaluate(() => window.__paletteBox);
  const focus = await region(page, [{ x: box.x, y: box.y, width: box.right - box.x, height: box.bottom - box.y }], 24);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  results.push(...(await rec.stop({ out, name: "search", focus, focusFrom, focusTo })));
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
  await page.waitForTimeout(600);
  // Focus: the composer, where the Send button (bottom right) changes, and the agent working
  // above it (3:1, not a thin strip).
  const bar = await region(page, [page.getByRole("textbox").first(), page.getByRole("button", { name: "Attach files" }).first(), page.getByRole("button", { name: /Send|Steer|Follow-up|Queue|Ask/ }).last()], 14);
  const tall = Math.round(bar.w / 3);
  const focus = { ...bar, y: bar.y + bar.h - tall, h: tall };
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
