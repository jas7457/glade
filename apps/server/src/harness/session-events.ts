/**
 * Listener sets for a {@link HarnessSession}'s `onEvent`/`onExit` (I-069). Sessions own one and
 * delegate to it (composition, not a base class):
 *
 *   private readonly events = new SessionEvents(log);
 *   onEvent(l) { return this.events.onEvent(l); }
 *   ...this.events.emit(event); this.events.exit(error);
 *
 * A throwing listener is logged and doesn't stop the others.
 */
import type { AgentEvent } from "@glade/protocol";

export class SessionEvents {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly exitListeners = new Set<(error: Error | null) => void>();

  constructor(private readonly log?: (msg: string) => void) {}

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.log?.(`event listener failed: ${(err as Error).message}`);
      }
    }
  }

  exit(error: Error | null): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(error);
      } catch (err) {
        this.log?.(`exit listener failed: ${(err as Error).message}`);
      }
    }
  }
}
