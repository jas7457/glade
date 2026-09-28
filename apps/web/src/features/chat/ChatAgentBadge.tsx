/**
 * Which agent a chat runs on (I-119), next to the location badge in the chat header: only when the
 * shown session's harness isn't the default one (e.g. an ACP agent). Tooltip: "Runs on <label>
 * (ACP)". Nothing until the harness list has loaded.
 */
import { Bot } from "lucide-preact";
import { isAcpHarnessId } from "@glade/protocol";
import { defaultHarnessOf, harnessesOf } from "@/state/harnesses";
import { envIdOfSession, sessionsById } from "@/state/store";
import { Badge } from "@/ui";

export function ChatAgentBadge({ sessionId, class: className }: { sessionId: string; class?: string }) {
  const harnessId = sessionsById.value.get(sessionId)?.harness;
  // The chat's environment's agents (I-123).
  const envId = envIdOfSession(sessionId);
  const list = harnessesOf(envId);
  if (!harnessId || !list || harnessId === defaultHarnessOf(envId)?.id) return null;
  const info = list.find((h) => h.id === harnessId);
  const label = info?.label ?? harnessId;
  const title = `Runs on ${label}${isAcpHarnessId(harnessId) ? " (ACP)" : ""}${info ? "" : ", which isn't installed"}`;
  return (
    <Badge icon={<Bot />} title={title} class={className}>
      {label}
    </Badge>
  );
}
