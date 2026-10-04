/**
 * llama.cpp's `llama-server` in router mode as a local-models backend (I-196).
 *
 * The router (started without `-m`, with `--models-dir` / `--models-preset`) answers:
 *   GET  /models          { data: [{ id, path?, status: { value, args?, failed?, exit_code? }, meta? }] }
 *   GET  /props           { role: "router", max_instances, models_autoload, … }
 *   POST /models/load     { model } → { success: true } | { error: { code, message, type } }
 *   POST /models/unload   { model } → same
 * (tools/server/README.md, "Using multiple models"). A llama-server started with `-m` serves one
 * model and has no model management: reported as an `error` with how to fix it.
 *
 * Mapping: `status.value` loaded/loading/unloaded/sleeping as is, `downloading` → loading,
 * `failed: true` → failed (with the exit code in words). Size: `meta.size` once loaded, else the
 * size of the GGUF file(s) on disk (`path`, or `-m` in `status.args`; split models are summed),
 * else null. Context: `meta.n_ctx`, else `-c`/`--ctx-size` in the args, else (loaded) the
 * training context, else null.
 *
 * The load API takes only `{ model }`: a requested context length can't be applied per load (it
 * comes from the router's `-c` or the model's preset), so it's ignored.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LocalModel, LocalModelStatus } from "@glade/protocol";
import { LocalModelsError, type LocalModelsBackend, type LocalModelsSnapshot } from "./backend.js";

export interface LlamaServerOptions {
  /** Base URL, e.g. `http://127.0.0.1:8080` (a trailing `/` or `/v1` is ignored). */
  url: string;
  /** Sent as `Authorization: Bearer` when set (llama-server `--api-key`; Glade reads `LLAMA_API_KEY`). */
  apiKey?: string;
  /** Per-request timeout for reads (ms). Default 3 s. */
  timeoutMs?: number;
  /**
   * Per-request timeout for load/unload (ms). Default 60 s: with `--models-max N` (> 0) a load
   * first waits for the router to unload its least recently used model when N are running.
   */
  actionTimeoutMs?: number;
  /** File size lookup (tests). Default: stat the file(s), `null` when missing. */
  fileSize?: (path: string) => Promise<number | null>;
  fetch?: typeof fetch;
}

/** The router's model entry (only what we read). */
interface RouterModel {
  id?: unknown;
  path?: unknown;
  status?: { value?: unknown; args?: unknown; failed?: unknown; exit_code?: unknown };
  meta?: { n_ctx?: unknown; n_ctx_train?: unknown; size?: unknown } | null;
}

/** Normalized base URL: no trailing slashes, no `/v1` (pi accepts both forms too). */
export function normalizeLlamaUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export class LlamaServerBackend implements LocalModelsBackend {
  readonly kind = "llama-server" as const;
  readonly url: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly fileSize: (path: string) => Promise<number | null>;

  constructor(private readonly options: LlamaServerOptions) {
    this.url = options.url;
    this.base = normalizeLlamaUrl(options.url);
    this.fetch = options.fetch ?? fetch;
    this.fileSize = options.fileSize ?? ggufSize;
  }

  async list(): Promise<LocalModelsSnapshot> {
    const down = (error: string): LocalModelsSnapshot => ({ reachable: false, error, models: [], maxLoaded: null });
    let models: Response;
    try {
      models = await this.request("GET", "/models");
    } catch (err) {
      return down(this.unreachable(err));
    }
    const props = await this.request("GET", "/props")
      .then(async (r) => (r.ok ? ((await r.json()) as Record<string, unknown>) : null))
      .catch(() => null);
    const up = (error: string): LocalModelsSnapshot => ({ reachable: true, error, models: [], maxLoaded: null });
    if (models.status === 401 || models.status === 403) return up("llama-server wants an API key: set LLAMA_API_KEY for Glade to the router's --api-key");
    const body = models.ok ? ((await models.json().catch(() => null)) as { data?: unknown } | null) : null;
    const data = Array.isArray(body?.data) ? (body.data as RouterModel[]) : null;
    const isRouter = props?.role === "router" || (data !== null && data.every((m) => typeof m?.status?.value === "string"));
    if (!isRouter || data === null) {
      if (props && props.role !== "router") return up("llama-server is running a single model; start it without -m to manage models");
      if (!props) return up(`${this.url} doesn't look like llama-server (GET /models answered HTTP ${models.status})`);
      return up(`llama-server at ${this.url} didn't list its models (HTTP ${models.status})`);
    }
    const mapped = await Promise.all(data.filter((m) => typeof m?.id === "string" && m.id).map((m) => this.toModel(m)));
    const max = typeof props?.max_instances === "number" && props.max_instances > 0 ? props.max_instances : null;
    return { reachable: true, error: null, models: sortModels(mapped), maxLoaded: max };
  }

  async load(id: string): Promise<void> {
    await this.action("/models/load", id, "load");
  }

  async unload(id: string): Promise<void> {
    await this.action("/models/unload", id, "unload");
  }

  private async action(path: string, id: string, verb: "load" | "unload"): Promise<void> {
    let res: Response;
    try {
      res = await this.request("POST", path, { model: id }, this.options.actionTimeoutMs ?? 60_000);
    } catch (err) {
      throw new LocalModelsError(502, this.unreachable(err));
    }
    if (res.ok) return;
    const payload = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
    const raw = typeof payload?.error === "string" ? payload.error : typeof payload?.error?.message === "string" ? payload.error.message : `HTTP ${res.status}`;
    throw actionError(raw, id, verb);
  }

  private async toModel(m: RouterModel): Promise<LocalModel> {
    const id = m.id as string;
    const value = typeof m.status?.value === "string" ? m.status.value : "unloaded";
    const args = Array.isArray(m.status?.args) ? m.status.args.filter((a): a is string => typeof a === "string") : [];
    const failed = m.status?.failed === true && value === "unloaded";
    const status: LocalModelStatus = failed ? "failed" : mapStatus(value);
    const meta = m.meta ?? {};
    const loaded = status === "loaded";
    let sizeBytes = loaded && positive(meta.size) ? (meta.size as number) : null;
    if (sizeBytes === null) {
      const file = typeof m.path === "string" && m.path ? m.path : argValue(args, ["-m", "--model"]);
      sizeBytes = file ? await this.fileSize(file).catch(() => null) : null;
    }
    const ctxArg = Number(argValue(args, ["-c", "--ctx-size", "-ctx"]));
    const contextLength = positive(meta.n_ctx)
      ? (meta.n_ctx as number)
      : Number.isSafeInteger(ctxArg) && ctxArg > 0
        ? ctxArg
        : loaded && positive(meta.n_ctx_train)
          ? (meta.n_ctx_train as number)
          : null;
    const model: LocalModel = { id, name: displayName(id), status, sizeBytes, contextLength };
    if (failed) {
      const code = m.status?.exit_code;
      model.error = typeof code === "number" ? `It didn't load (llama-server's model process exited with code ${code}).` : "It didn't load.";
    }
    return model;
  }

  private request(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = this.options.timeoutMs ?? 3000): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    return this.fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private unreachable(err: unknown): string {
    const name = (err as { name?: string } | null)?.name;
    return name === "TimeoutError" || name === "AbortError" ? `llama-server at ${this.url} didn't answer` : `llama-server isn't running at ${this.url}`;
  }
}

/** The router's error text → our status + words. */
function actionError(raw: string, id: string, verb: "load" | "unload"): LocalModelsError {
  if (/not found/i.test(raw)) return new LocalModelsError(404, `llama-server has no model ${id}`);
  if (/already (running|loaded)/i.test(raw)) return new LocalModelsError(409, `${id} is already loaded`);
  if (/not (running|loaded)/i.test(raw)) return new LocalModelsError(409, `${id} isn't loaded`);
  if (/limit reached/i.test(raw)) return new LocalModelsError(409, "llama-server already has as many models loaded as it allows (--models-max); unload one first");
  return new LocalModelsError(502, `llama-server couldn't ${verb} ${id}: ${raw}`);
}

function mapStatus(value: string): LocalModelStatus {
  switch (value) {
    case "loaded":
    case "loading":
    case "sleeping":
      return value;
    case "downloading":
      return "loading";
    default:
      return "unloaded";
  }
}

/** Loaded and sleeping models first, then by name. A loading model stays in place until it's loaded, so rows don't jump. */
export function sortModels(models: LocalModel[]): LocalModel[] {
  const rank = (m: LocalModel) => (m.status === "loaded" || m.status === "sleeping" ? 0 : 1);
  return [...models].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/**
 * A readable name: Hugging Face ids (`ggml-org/gemma-3-4b-it-GGUF:Q4_K_M`) lose the owner and the
 * `-GGUF` marker (`gemma-3-4b-it:Q4_K_M`); file stems stay as they are.
 */
export function displayName(id: string): string {
  const slash = id.lastIndexOf("/");
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  return tail.replace(/-GGUF(?=:|$)/i, "") || id;
}

function argValue(args: string[], flags: string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) if (flags.includes(args[i]!)) return args[i + 1]!;
  return null;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A GGUF's size in bytes; split models (`…-00001-of-00003.gguf`) count every part. `null` when missing. */
export async function ggufSize(path: string): Promise<number | null> {
  const split = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(basename(path));
  try {
    if (!split) {
      const s = await stat(path);
      return s.isFile() ? s.size : null;
    }
    const [, prefix, , total] = split;
    const dir = dirname(path);
    const parts = (await readdir(dir)).filter((f) => f.startsWith(`${prefix}-`) && f.toLowerCase().endsWith(`-of-${total}.gguf`));
    const sizes = await Promise.all(parts.map(async (f) => (await stat(join(dir, f))).size));
    return sizes.reduce((a, b) => a + b, 0) || null;
  } catch {
    return null;
  }
}
