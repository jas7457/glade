/**
 * Context bar: which agent (harness) the new chat runs in (I-119). Only shown when more than one
 * is installed (pi plus ACP agents from Settings → Agents). The default comes first.
 */
import { Bot, ChevronDown } from "lucide-preact";
import { isAcpHarnessId } from "@glade/protocol";
import { harnesses, newChatHarness, newChatHarnessInfo } from "@/state/harnesses";
import { Menu, MenuCheckItem } from "@/ui";
import { barButtonClass } from "./shared";

export function AgentPicker() {
  const list = harnesses.value ?? [];
  const current = newChatHarnessInfo.value;
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
