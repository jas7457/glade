/**
 * Shared state of the app service (I-094). `AppService` creates one `AppContext` and hands it to
 * the modules in this folder (records, live pool, lease sync, sessions, …); they share the maps
 * below instead of reaching into each other. Nothing here has behaviour beyond bookkeeping.
 */
import { join } from "node:path";
import type { ServerMessage, Transcript, UiRequest } from "@glade/protocol";
import type { HarnessRegistry } from "../../harness/registry.js";
import type { AgentHarness, HarnessSession } from "../../harness/types.js";
import type { Store } from "../../store/store.js";
import { AgentRegistry, AgentTokens } from "../agents.js";
import { AttachmentStore } from "../attachments.js";
import { CHATS_DIR } from "../../store/blobs.js";
import type { LeaseManager } from "../leases.js";
import type { OpenIn } from "../open-in.js";
import type { RevealPath } from "../reveal.js";
import type { ServerRegistry } from "../server-registry.js";
import type { UsageLimitsHub } from "../usage-hub.js";
import type { MessageIds, TranscriptWriter } from "./transcript-writer.js";

export interface AppServiceOptions {
  store: Store;
  /**
   * Installed harnesses (I-064). Sessions run in the harness that created them
   * (`Session.harness`); new chats and app-level things (model list, usage limits) use the default.
   */
  harnesses: HarnessRegistry;
  scratchDir: string;
  /** "Reveal in Finder" (injectable for tests). Default: `open -R` on macOS. */
  revealPath?: RevealPath;
  /** "Open in <app>" for project folders (injectable for tests). Default: `open -a` on macOS. */
  openIn?: OpenIn;
  log?: (msg: string) => void;
  /** App data folder (default: the store's). */
  dataDir?: string;
  /** This server's base URL, handed to agents as `GLADE_URL` (see `AppService.setServerUrl`). */
  serverUrl?: string;
  /** Called after a session's run settles (e.g. to refresh the search index). */
  onRunEnd?: (sessionId: string) => void;
  /**
   * I-062: this server's entry in the data folder's server registry. When given, the service
   * shares the folder with other servers: session leases (only one server runs a session's
   * agent), and the store's files are watched so other servers' changes reach our clients.
   */
  registry?: ServerRegistry;
  /** Lease scan interval (ms; tests lower it). */
  leaseScanMs?: number;
  /** Attached files (I-090). Default: `<dataDir>/chats/<sessionId>/files` (I-163). */
  attachments?: AttachmentStore;
  /** Idle agent processes kept alive (I-159: not a setting; default {@link MAX_IDLE_PROCESSES}; tests lower it). */
  maxIdleProcesses?: number;
}

/** The live pool keeps at most this many idle agent processes (I-159); working ones are never stopped. */
export const MAX_IDLE_PROCESSES = 5;

export interface LiveSession {
  /** The harness running it (`Session.harness`). */
  harness: AgentHarness;
  session: HarnessSession;
  transcript: Transcript;
  pendingUi: Map<string, UiRequest>;
  /** Auto-close timers for dialogs with a timeout (the agent resolves them itself). */
  uiTimers: Map<string, NodeJS.Timeout>;
  /** Between run_start and run_end. Tracked here so it's correct while those events are handled. */
  running: boolean;
  /** When the current run started (I-070), `null` when idle. */
  runStartedAt: number | null;
  lastUsedAt: number;
  /** When a prompt was last sent. */
  lastPromptAt: number;
  /** A prompt was sent and its run hasn't started (or ended) yet: refuse take-overs meanwhile. */
  awaitingRun: boolean;
  /** Ids of the user's shell commands still running (I-076): keep the process alive meanwhile. */
  shells: Set<string>;
  /** Ids of side questions still being answered (I-140): keep the process alive meanwhile. */
  sideQuestions: Set<string>;
  /** Harness message ids -> stable Glade ids (I-121). */
  ids: MessageIds;
  /** Writes the conversation to the store (coalesced). */
  writer: TranscriptWriter;
  unsubscribe: () => void;
  /**
   * A native sub-agent's mirror (I-188, `native-subagents.ts`): the parent session whose harness
   * runs it. No process of its own; never evicted, ended by the parent.
   */
  nativeParentId?: string;
}

export type Listener = (message: ServerMessage) => void;

/** Per-session sub-agent timers (auto-close, close grace; I-037). */
export class AgentTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  has(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  set(sessionId: string, ms: number, fn: () => void): void {
    this.clear(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      fn();
    }, ms);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  clear(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export interface AppContext {
  readonly options: AppServiceOptions;
  readonly store: Store;
  readonly harnesses: HarnessRegistry;
  /** sessionId -> live agent. */
  readonly live: Map<string, LiveSession>;
  readonly opening: Map<string, Promise<LiveSession>>;
  readonly listeners: Set<Listener>;
  /** sessionId -> number of clients currently viewing it. */
  readonly viewers: Map<string, number>;
  /** Files written by `exportSession` this run; the only paths `revealPath` will show. */
  readonly exported: Set<string>;
  /** Files attached by reference (I-090), per session; removed with the session. */
  readonly attachments: AttachmentStore;
  /** Agent API (I-037): sub-agent records, per-process tokens, timers, delivery queues. */
  readonly agents: AgentRegistry;
  readonly tokens: AgentTokens;
  readonly agentTimers: AgentTimers;
  readonly deliveries: Map<string, Promise<void>>;
  /** Set once by `AppService`'s constructor. */
  usage: UsageLimitsHub | null;
  /** Session leases shared with other servers on the data folder (null = single server, tests). */
  leases: LeaseManager | null;
  serverUrl: string | null;
  /** This device's name for messages (I-155, "pi is turned off on <device>"); set by `AppService`. */
  deviceName: () => string;
  disposed: boolean;
  /** Push a message to every subscribed client. */
  broadcast(message: ServerMessage): void;
}

export function createAppContext(options: AppServiceOptions): AppContext {
  const listeners = new Set<Listener>();
  const agents = new AgentRegistry(options.store);
  const dataDir = options.dataDir ?? options.store.dataDir;
  const attachments = options.attachments ?? new AttachmentStore(join(dataDir, CHATS_DIR), join(dataDir, "attachments"));
  return {
    options,
    store: options.store,
    harnesses: options.harnesses,
    live: new Map(),
    opening: new Map(),
    listeners,
    viewers: new Map(),
    exported: new Set(),
    attachments,
    agents,
    tokens: new AgentTokens(),
    agentTimers: new AgentTimers(),
    deliveries: new Map(),
    usage: null,
    leases: null,
    serverUrl: options.serverUrl ?? null,
    deviceName: () => "this device",
    disposed: false,
    broadcast(message) {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (err) {
          options.log?.(`listener failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
