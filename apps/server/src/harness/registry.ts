/**
 * The harnesses this server can run (I-064), by id. Sessions are routed to the harness that
 * created them (`Session.harness`); new chats and folder-level things (models, folder commands,
 * defaults, usage limits) use the default harness: the `agent.defaultHarness` setting when that
 * harness is registered, else the first one registered.
 *
 *   const harnesses = new HarnessRegistry([pi], { preferred: () => settings().agent.defaultHarness });
 *   harnesses.get(session.harness)  // undefined when not installed
 *   harnesses.default()             // for new chats
 *
 * Harnesses the user configures (ACP agents, I-119) come from `dynamic`, read on every lookup,
 * so adding/removing one in Settings takes effect without a restart. Static ones win on id clashes.
 */
import type { HarnessInfo } from "@glade/protocol";
import type { AgentHarness } from "./types.js";

export interface HarnessRegistryOptions {
  /** Preferred default id (a setting); ignored when that harness isn't registered. */
  preferred?: () => string | null | undefined;
  /** Harnesses configured at runtime (ACP agents from the settings, I-119), after the static ones. */
  dynamic?: () => AgentHarness[];
}

export class HarnessRegistry {
  private readonly byId = new Map<string, AgentHarness>();

  constructor(
    harnesses: AgentHarness[] = [],
    private readonly options: HarnessRegistryOptions = {},
  ) {
    for (const harness of harnesses) this.register(harness);
  }

  register(harness: AgentHarness): void {
    if (this.byId.has(harness.id)) throw new Error(`Harness "${harness.id}" is already registered`);
    this.byId.set(harness.id, harness);
  }

  get(id: string): AgentHarness | undefined {
    return this.byId.get(id) ?? this.dynamic().find((h) => h.id === id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** Registered harnesses in registration order, then the dynamic ones. */
  list(): AgentHarness[] {
    return [...this.byId.values(), ...this.dynamic()];
  }

  private dynamic(): AgentHarness[] {
    return (this.options.dynamic?.() ?? []).filter((h) => !this.byId.has(h.id));
  }

  /** The harness new chats use. Throws when nothing is registered. */
  default(): AgentHarness {
    const preferred = this.options.preferred?.();
    const harness = (preferred ? this.get(preferred) : undefined) ?? this.byId.values().next().value ?? this.dynamic()[0];
    if (!harness) throw new Error("No harness is registered");
    return harness;
  }

  /** `GET /api/harnesses`: the default harness first. */
  info(): HarnessInfo[] {
    const fallback = this.default();
    const list = [fallback, ...this.list().filter((h) => h !== fallback)];
    return list.map((h) => ({ id: h.id, label: h.info.label, isDefault: h === fallback, capabilities: { ...h.info.capabilities } }));
  }

  async dispose(): Promise<void> {
    await Promise.all(this.list().map((h) => h.dispose()));
  }
}
