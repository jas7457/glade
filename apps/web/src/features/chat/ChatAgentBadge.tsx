/**
 * Which agent a chat runs on (I-119), next to the location badge in the chat header. I-176: for
 * every chat when its Mac offers two or more agents (the rule lives in `chatAgentOf`, shared with
 * the iPhone). Tooltip: "Runs on <label> (ACP)". Nothing until the harness list has loaded.
 */
import { Bot } from "lucide-preact";
import { chatAgentOf } from "@glade/app-core/state/chat-agent";
import { Badge } from "@glade/app-core/ui";

export function ChatAgentBadge({ sessionId, class: className }: { sessionId: string; class?: string }) {
  const agent = chatAgentOf(sessionId);
  if (!agent) return null;
  return (
    <Badge icon={<Bot />} title={agent.title} class={className}>
      {agent.label}
    </Badge>
  );
}
