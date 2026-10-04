/**
 * An in-process fake llama-server router for tests (I-196), same JSON as the real one
 * (tools/server/server-models.cpp) and `scripts/fake-llama-server.mjs`, but driven by the test:
 * loads stay `loading` until `finish(id)` (or `fail(id)`), unloads are immediate.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRouterModel {
  status: "unloaded" | "loading" | "loaded" | "sleeping" | "downloading";
  failed?: boolean;
  exitCode?: number;
  size?: number;
  nCtx?: number;
  args?: string[];
  path?: string;
}

export interface FakeRouter {
  url: string;
  models: Map<string, FakeRouterModel>;
  props: Record<string, unknown>;
  /** Requests seen, e.g. `POST /models/load Qwen`. */
  requests: string[];
  /** Answer every request with this status (e.g. 401), or `null`. */
  forceStatus: number | null;
  /** Serve a single-model llama-server instead (no statuses, role "model"). */
  singleModel: boolean;
  finish(id: string): void;
  fail(id: string, exitCode?: number): void;
  close(): Promise<void>;
}

export async function startFakeRouter(models: Record<string, FakeRouterModel> = {}): Promise<FakeRouter> {
  const router: FakeRouter = {
    url: "",
    close: async () => {},
    models: new Map(Object.entries(models)),
    props: { role: "router", max_instances: 4, models_autoload: false },
    requests: [],
    forceStatus: null,
    singleModel: false,
    finish(id) {
      const m = router.models.get(id);
      if (m) Object.assign(m, { status: "loaded", failed: false });
    },
    fail(id, exitCode = 1) {
      const m = router.models.get(id);
      if (m) Object.assign(m, { status: "unloaded", failed: true, exitCode });
    },
  };
  const send = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const error = (res: import("node:http").ServerResponse, code: number, message: string) => send(res, code, { error: { code, message, type: "invalid_request_error" } });
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
    const path = new URL(req.url ?? "/", "http://x").pathname;
    router.requests.push(`${req.method} ${path}${body.model ? ` ${body.model}` : ""}`);
    if (router.forceStatus) return error(res, router.forceStatus, "forced");
    if (router.singleModel) {
      if (path === "/props") return send(res, 200, { role: "model", model_path: "/m/x.gguf" });
      if (path === "/models") return send(res, 200, { object: "list", data: [{ id: "x", object: "model" }] });
      return error(res, 404, "File Not Found");
    }
    if (req.method === "GET" && path === "/props") return send(res, 200, router.props);
    if (req.method === "GET" && path === "/models") {
      const data = [...router.models].map(([id, m]) => {
        const status: Record<string, unknown> = { value: m.status, args: m.args ?? ["llama-server", "-m", m.path ?? `/nowhere/${id}.gguf`] };
        if (m.failed) Object.assign(status, { failed: true, exit_code: m.exitCode ?? 1 });
        const out: Record<string, unknown> = { id, aliases: [], tags: [], object: "model", status };
        if (m.status === "loaded") out.meta = { n_ctx: m.nCtx ?? 4096, size: m.size ?? 1000 };
        return out;
      });
      return send(res, 200, { object: "list", data });
    }
    const m = body.model ? router.models.get(body.model) : undefined;
    if (req.method === "POST" && path === "/models/load") {
      if (!m) return error(res, 404, "model is not found");
      if (m.status !== "unloaded") return error(res, 400, "model is already running");
      Object.assign(m, { status: "loading", failed: false });
      return send(res, 200, { success: true });
    }
    if (req.method === "POST" && path === "/models/unload") {
      if (!m) return error(res, 400, "model is not found");
      if (m.status === "unloaded") return error(res, 400, "model is not running");
      m.status = "unloaded";
      return send(res, 200, { success: true });
    }
    return error(res, 404, "File Not Found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  router.url = `http://127.0.0.1:${port}`;
  router.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return router;
}

/** A URL nothing listens on. */
export async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
