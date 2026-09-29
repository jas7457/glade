/**
 * The one `codex app-server` process a Glade server shares between all its Codex chats (I-177).
 * The app-server hosts many threads; every notification and request names its thread, so this
 * class routes them to the chat that registered the thread id.
 *
 * - Started lazily (the first model list or chat), `initialize`d with the experimental API (for
 *   Glade's dynamic tools), then `account/read` (sign-in state) and `config/read` (the user's
 *   default model, effort, approval policy and sandbox).
 * - Account-wide notifications (`account/rateLimits/updated`) update the cached rate limits;
 *   `rateLimits()` reads them fresh when asked.
 * - When the process ends every registered thread hears about it (`closed`); the next call starts
 *   a new process (chats resume their threads there).
 * - Requests Codex sends for threads nobody registered are refused with a JSON-RPC error.
 */
import { isLimitReached } from "./errors.js";
import { CodexRpc, CodexRpcError, type CodexTransport } from "./rpc.js";
import type {
  CodexConfig,
  CodexModel,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  InitializeResponse,
  ModelListResponse,
  RateLimitSnapshot,
  RequestId,
} from "./protocol.js";

/** What a chat registers for its thread. */
export interface ThreadListener {
  notification(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>, id: RequestId): Promise<unknown>;
  /** The process ended (`error` null: it was stopped on purpose). */
  closed(error: Error | null): void;
}

export interface CodexAppServerOptions {
  /** Start a transport (the real `codex app-server`, or a fake in tests); throws when Codex isn't installed. */
  connect: () => CodexTransport;
  /** Glade's version, sent as `clientInfo.version`. */
  version?: string;
  requestTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Connection {
  rpc: CodexRpc;
  init: InitializeResponse;
  account: GetAccountResponse | null;
  config: CodexConfig | null;
}

const MODELS_TTL_MS = 60_000;

export class CodexAppServer {
  private connection: Promise<Connection> | null = null;
  private live: Connection | null = null;
  private readonly threads = new Map<string, ThreadListener>();
  private models: { at: number; value: Promise<CodexModel[]> } | null = null;
  private limits: GetAccountRateLimitsResponse | null = null;
  private disposed = false;

  constructor(private readonly options: CodexAppServerOptions) {}

  /** The running process (started if needed). */
  async ensure(): Promise<Connection> {
    if (this.disposed) throw new Error("Codex has been shut down");
    this.connection ??= this.start().catch((err: Error) => {
      this.connection = null;
      throw err;
    });
    return this.connection;
  }

  private async start(): Promise<Connection> {
    const transport = this.options.connect();
    const rpc = new CodexRpc(
      transport,
      {
        notification: (method, params) => this.onNotification(method, params),
        request: (method, params, id) => this.onRequest(method, params, id),
      },
      this.options.requestTimeoutMs,
    );
    rpc.onClose((error) => this.onClose(rpc, error));
    try {
      const init = await rpc.request<InitializeResponse>(
        "initialize",
        { clientInfo: { name: "glade", title: "Glade", version: this.options.version ?? "0.0.0" }, capabilities: { experimentalApi: true } },
        30_000,
      );
      rpc.notify("initialized");
      const [account, config] = await Promise.all([
        rpc.request<GetAccountResponse>("account/read", {}).catch(() => null),
        rpc.request<{ config: CodexConfig }>("config/read", {}).then((r) => r.config, () => null),
      ]);
      const connection: Connection = { rpc, init, account, config };
      this.live = connection;
      return connection;
    } catch (err) {
      rpc.close();
      throw err instanceof Error ? new Error(`Codex didn't start: ${err.message}`) : err;
    }
  }

  private onClose(rpc: CodexRpc, error: Error | null): void {
    if (this.live?.rpc === rpc || !this.live) {
      this.live = null;
      this.connection = null;
      this.models = null;
    }
    if (error) this.options.log?.(`codex: ${error.message}`);
    for (const listener of [...this.threads.values()]) listener.closed(error ?? new Error("codex app-server exited"));
  }

  /** A request on the running process. */
  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const { rpc } = await this.ensure();
    return rpc.request<T>(method, params, timeoutMs);
  }

  register(threadId: string, listener: ThreadListener): () => void {
    this.threads.set(threadId, listener);
    return () => {
      if (this.threads.get(threadId) === listener) this.threads.delete(threadId);
    };
  }

  /** Signed in (or doesn't need to be): `false` only when Codex says it needs an OpenAI login. */
  async loggedIn(): Promise<boolean> {
    const { account } = await this.ensure();
    return !account || !!account.account || !account.requiresOpenaiAuth;
  }

  async config(): Promise<CodexConfig | null> {
    return (await this.ensure()).config;
  }

  /** `model/list` (every page), cached for a minute. */
  listModels(force = false): Promise<CodexModel[]> {
    const hit = this.models;
    if (hit && !force && Date.now() - hit.at < MODELS_TTL_MS) return hit.value;
    const value = (async () => {
      const out: CodexModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res: ModelListResponse = await this.request<ModelListResponse>("model/list", cursor ? { cursor } : {});
        out.push(...res.data);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return out;
    })();
    this.models = { at: Date.now(), value };
    value.catch(() => {
      if (this.models?.value === value) this.models = null;
    });
    return value;
  }

  /** The account's rate limits (`account/rateLimits/read`); the last known ones when that fails. */
  async rateLimits(): Promise<GetAccountRateLimitsResponse | null> {
    try {
      this.limits = await this.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined, 15_000);
    } catch (err) {
      this.options.log?.(`codex: reading rate limits failed: ${(err as Error).message}`);
    }
    return this.limits;
  }

  /**
   * The account's rate limits when Codex's backend says its included usage is used up
   * (`ordinaryUsageAllowed: false`, no credits), else `null`. Reads them fresh unless the last
   * known ones are fine (a turn refused anyway re-reads them), so a chat can say so without
   * sending a turn that would only be refused.
   */
  async usageBlocked(): Promise<GetAccountRateLimitsResponse | null> {
    if (this.limits && !isLimitReached(this.limits)) return null;
    const fresh = await this.rateLimits();
    const credits = fresh?.rateLimits.credits;
    return fresh && fresh.ordinaryUsageAllowed === false && !credits?.hasCredits && !credits?.unlimited ? fresh : null;
  }

  /** The last rate limits seen (no request). */
  knownRateLimits(): GetAccountRateLimitsResponse | null {
    return this.limits;
  }

  private onNotification(method: string, raw: unknown): void {
    const params = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (method === "account/rateLimits/updated") return this.mergeLimits(params.rateLimits as RateLimitSnapshot | undefined);
    if (method === "account/updated" && this.live) {
      // Signed in or out elsewhere: read the account again.
      const live = this.live;
      void live.rpc.request<GetAccountResponse>("account/read", {}).then(
        (a) => (live.account = a),
        () => {},
      );
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (threadId) this.threads.get(threadId)?.notification(method, params);
  }

  /** A sparse update: fields it has replace the known snapshot's (for the same limit). */
  private mergeLimits(update: RateLimitSnapshot | undefined): void {
    if (!update || !this.limits) return;
    const known = this.limits.rateLimits;
    if (update.limitId && known.limitId && update.limitId !== known.limitId) return;
    const merged: RateLimitSnapshot = { ...known };
    for (const [key, value] of Object.entries(update) as Array<[keyof RateLimitSnapshot, unknown]>) {
      if (value !== null && value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    this.limits = { ...this.limits, rateLimits: merged };
  }

  private async onRequest(method: string, raw: unknown, id: RequestId): Promise<unknown> {
    const params = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const listener = threadId ? this.threads.get(threadId) : undefined;
    if (!listener) throw new CodexRpcError(`Glade has no chat for ${method}`, -32601);
    return listener.request(method, params, id);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const connection = this.live;
    this.live = null;
    this.connection = null;
    connection?.rpc.close();
  }
}
