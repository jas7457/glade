#!/usr/bin/env node
/**
 * A fake llama.cpp `llama-server` in router mode (I-196), for tests and sandboxes when no real
 * llama.cpp is installed. Mirrors the router's model-management API (tools/server/server-models.cpp):
 *
 *   GET  /health         → { status: "ok" }
 *   GET  /props          → { role: "router", max_instances, models_autoload, … }
 *   GET  /models         → { object: "list", data: [{ id, aliases, tags, object, owned_by, created,
 *                             status: { value, args, failed?, exit_code? }, meta? }] }
 *                           (`meta` = { n_ctx, size } once loaded)
 *   POST /models/load    { model } → { success: true }; 404-ish error when unknown, 400 when running
 *   POST /models/unload  { model } → { success: true }; 400 when not running
 *   GET  /v1/models      → OpenAI-style list of the loaded models
 *
 * Loads take LOAD_MS (default 3000) in `loading` before `loaded`; the model named `broken-model`
 * fails (status back to `unloaded` with `failed: true, exit_code: 1`). At most `--models-max`
 * (default 4) run at once ("model limit reached, try again later").
 *
 *   node scripts/fake-llama-server.mjs [--port 8080] [--models-max 4] [--load-ms 3000] [--demo]
 *
 * `--demo` (the website demo sandbox, I-209) serves a catalog of models that fit a 16 GB Mac, without
 * `broken-model`.
 *
 * Prints `fake llama-server listening on http://127.0.0.1:<port>` once ready (port 0 = any free port).
 */
import { createServer } from "node:http";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", process.env.PORT ?? "8080"));
const modelsMax = Number(arg("models-max", "4"));
const loadMs = Number(arg("load-ms", process.env.LOAD_MS ?? "3000"));

const GB = 2 ** 30;
/** name → { size, nCtx } */
const CATALOG = {
  "Qwen3.8-27B-Q4_K_M": { size: Math.round(16.5 * GB), nCtx: 32768 },
  "Qwen3.6-35B-A3B-Q8_0": { size: Math.round(36.9 * GB), nCtx: 65536 },
  "gpt-oss-120b-MXFP4": { size: Math.round(63 * GB), nCtx: 32768 },
  "gemma-3-4b-it-Q4_K_M": { size: Math.round(2.5 * GB), nCtx: 8192 },
  "broken-model": { size: Math.round(1 * GB), nCtx: 4096 },
};
if (process.argv.includes("--demo")) {
  for (const id of Object.keys(CATALOG)) delete CATALOG[id];
  Object.assign(CATALOG, {
    "Qwen3.8-14B-Q5_K_M": { size: Math.round(10.2 * GB), nCtx: 32768 },
    "gpt-oss-20b-MXFP4": { size: Math.round(12.1 * GB), nCtx: 32768 },
    "gemma-3-4b-it-Q4_K_M": { size: Math.round(2.5 * GB), nCtx: 8192 },
    "Qwen3.6-35B-A3B-Q4_K_M": { size: Math.round(19.8 * GB), nCtx: 65536 },
  });
}
/** name → { status, failed, exitCode, timer } */
const state = new Map(Object.keys(CATALOG).map((id) => [id, { status: "unloaded", failed: false, exitCode: null, timer: null }]));
const created = Math.floor(Date.now() / 1000);

const running = () => [...state.values()].filter((m) => m.status === "loaded" || m.status === "loading").length;

function modelJson(id) {
  const m = state.get(id);
  const info = CATALOG[id];
  const status = { value: m.status, args: ["llama-server", "-m", `/models/${id}.gguf`, "--port", "0"] };
  if (m.failed) Object.assign(status, { failed: true, exit_code: m.exitCode });
  const out = { id, aliases: [], tags: [], object: "model", owned_by: "llamacpp", created, status };
  if (m.status === "loaded") out.meta = { n_ctx: info.nCtx, size: info.size };
  return out;
}

const error = (res, code, message, type = "invalid_request_error") => send(res, code, { error: { code, message, type } });
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok" });
  if (req.method === "GET" && path === "/props")
    return send(res, 200, { role: "router", max_instances: modelsMax, models_autoload: false, model_alias: "llama-server", model_path: "none", build_info: "fake" });
  if (req.method === "GET" && path === "/models") return send(res, 200, { object: "list", data: [...state.keys()].map(modelJson) });
  if (req.method === "GET" && path === "/v1/models")
    return send(res, 200, { object: "list", data: [...state.entries()].filter(([, m]) => m.status === "loaded").map(([id]) => ({ id, object: "model", owned_by: "llamacpp", created })) });
  if (req.method === "POST" && path === "/models/load") {
    const { model } = await readJson(req);
    const m = state.get(model);
    if (!m) return error(res, 404, "model is not found", "not_found_error");
    if (m.status === "loaded" || m.status === "loading") return error(res, 400, "model is already running");
    if (modelsMax > 0 && running() >= modelsMax) return error(res, 500, "model limit reached, try again later", "server_error");
    Object.assign(m, { status: "loading", failed: false, exitCode: null });
    m.timer = setTimeout(() => {
      if (model === "broken-model") Object.assign(m, { status: "unloaded", failed: true, exitCode: 1 });
      else m.status = "loaded";
    }, loadMs);
    return send(res, 200, { success: true });
  }
  if (req.method === "POST" && path === "/models/unload") {
    const { model } = await readJson(req);
    const m = state.get(model);
    if (!m) return error(res, 400, "model is not found");
    if (m.status !== "loaded" && m.status !== "loading") return error(res, 400, "model is not running");
    clearTimeout(m.timer);
    setTimeout(() => (m.status = "unloaded"), 300);
    return send(res, 200, { success: true });
  }
  return error(res, 404, "File Not Found", "not_found_error");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake llama-server listening on http://127.0.0.1:${server.address().port}`);
});
