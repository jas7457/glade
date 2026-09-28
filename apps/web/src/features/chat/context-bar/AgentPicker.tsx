/**
 * Context bar: which agent (harness) the new chat runs in (I-119). Only shown when more than one
 * is installed (pi plus ACP agents from Settings → Agents). The default comes first. Lists the
 * agents of the chat's environment (I-123).
 */
import { Bot, ChevronDown } from "lucide-preact";
import { isAcpHarnessId } from "@glade/protocol";
import { harnessesOf, newChatHarness, newChatHarnessFor } from "@/state/harnesses";
import { Menu, MenuCheckItem } from "@/ui";
import { barButtonClass } from "./shared";

export function AgentPicker({ envId = null }: { envId?: string | null }) {
  const list = harnessesOf(envId) ?? [];
  const current = newChatHarnessFor(envId);
  if (list.length < 2 || !current) return null;
  return (
    <Menu
      side="top"
      contentClass="min-w-[220px]"
      trigger={
        <button type="button" class={barButtonClass} aria-label={`Agent: ${current.label}`}>
          <Bot />
          <span class="truncate">{current.label}</span>
          <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
        </button>
      }
    >
      {list.map((h) => (
        <MenuCheckItem
          key={h.id}
          checked={h.id === current.id}
          onSelect={() => (newChatHarness.value = h.isDefault ? null : h.id)}
          detail={h.isDefault ? "default" : isAcpHarnessId(h.id) ? "ACP" : undefined}
        >
          {h.label}
        </MenuCheckItem>
      ))}
    </Menu>
  );
}
