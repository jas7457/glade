/**
 * ACP harness (I-119): runs any Agent Client Protocol agent the user configured in Settings →
 * Agents. Each configured agent is its own harness (`acp-<id>`, label = its name), produced by
 * {@link AcpHarnessProvider} from the settings and registered dynamically in the
 * `HarnessRegistry`, so adding or editing one needs no restart.
 *
 * What ACP gives Glade: streaming text/thinking, tool calls (with kinds and diffs), permission
 * requests, plans, slash commands (`available_commands_update`), context usage. What it lacks
 * (so the capabilities hide it): compaction, HTML export, steering, usage limits, Glade
 * sub-agents, `!` shell commands, Glade's model/thinking pickers, titles and one-shot completions.
 * Transcripts are kept in Glade's store like every harness's (I-121), so reloads, search and Ask
 * work without starting the agent; this harness only keeps what it needs to resume a chat
 * (`resume-store.ts`).
 */
import { acpHarnessId, normalizeAcpAgents, type AcpAgentConfig, type HarnessCapabilities, type ModelInfo } from "@glade/protocol";
import type { AgentHarness, HarnessDescription, HarnessSession, OpenSessionOptions } from "../types.js";
import { AcpSession, type AcpSessionOptions } from "./acp-session.js";
import { MemoryAcpResumeStore, newAcpSessionRef, type AcpResumeStore } from "./resume-store.js";

export const ACP_CAPABILITIES: HarnessCapabilities = {
  compact: false,
  exportHtml: false,
  steering: false,
  uiRequests: true,
  usageLimits: false,
  commands: true,
  subagents: false,
  shell: false,
  models: false,
};

export interface AcpHarnessOptions {
  /** Where the ACP session ids and titles are kept (the store; memory when omitted). */
  resume?: AcpResumeStore;
  log?: (msg: string) => void;
  /** Test hooks passed to every session (e.g. a shorter cancel grace period). */
  session?: Partial<Pick<AcpSessionOptions, "cancelGraceMs" | "startProcess" | "clientVersion">>;
}

export class AcpHarness implements AgentHarness {
  readonly id: string;
  readonly info: HarnessDescription;
  private readonly store: AcpResumeStore;

  constructor(
    readonly config: AcpAgentConfig,
    private readonly options: AcpHarnessOptions,
  ) {
    this.id = acpHarnessId(config.id);
    this.info = { label: config.name, capabilities: { ...ACP_CAPABILITIES } };
    this.store = options.resume ?? new MemoryAcpResumeStore();
  }

  /** ACP agents pick their own model; Glade's pickers are hidden (`capabilities.models`). */
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    const resume = options.sessionRef ? this.store.load(options.sessionRef) : null;
    const sessionRef = options.sessionRef ?? newAcpSessionRef();
    return new AcpSession({
      harnessId: this.id,
      config: this.config,
      cwd: options.cwd,
      sessionRef,
      resume,
      store: this.store,
      log: this.options.log,
      ...this.options.session,
    });
  }

  async deleteSession(sessionRef: string): Promise<void> {
    this.store.delete(sessionRef);
  }

  async dispose(): Promise<void> {}
}

/**
 * The ACP harnesses for the configured agents (`Settings.harnesses.acp.agents`), read on every
 * call; an agent keeps its harness instance until its configuration changes.
 */
export class AcpHarnessProvider {
  private readonly cache = new Map<string, { key: string; harness: AcpHarness }>();

  constructor(
    private readonly agents: () => unknown,
    private readonly options: AcpHarnessOptions,
  ) {}

  list(): AcpHarness[] {
    const configs = normalizeAcpAgents(this.agents());
    const out: AcpHarness[] = [];
    for (const config of configs) {
      const key = JSON.stringify(config);
      let entry = this.cache.get(config.id);
      if (!entry || entry.key !== key) {
        entry = { key, harness: new AcpHarness(config, this.options) };
        this.cache.set(config.id, entry);
      }
      out.push(entry.harness);
    }
    for (const id of [...this.cache.keys()]) if (!configs.some((c) => c.id === id)) this.cache.delete(id);
    return out;
  }
}
