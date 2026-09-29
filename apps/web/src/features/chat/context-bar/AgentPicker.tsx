/**
 * Context bar: which agent (harness) the new chat runs in (I-119). Only shown when more than one
 * is installed (pi plus ACP agents from Settings → Agents). The default comes first. Lists the
 * agents of the chat's environment (I-123). A bottom sheet instead of a menu inside an
 * `OptionSheetContext` (the iPhone app, I-164).
 */
import { Bot, ChevronDown } from "lucide-preact";
import { isAcpHarnessId } from "@glade/protocol";
import { harnessesOf, newChatHarness, newChatHarnessFor } from "@/state/harnesses";
import { Menu, MenuCheckItem } from "@/ui";
import { SheetPicker } from "../Pickers";
import { useOptionSheet } from "../option-sheet";
import { barButtonClass } from "./shared";

export function AgentPicker({ envId = null }: { envId?: string | null }) {
  const list = harnessesOf(envId) ?? [];
  const current = newChatHarnessFor(envId);
  const sheet = useOptionSheet();
  if (list.length < 2 || !current) return null;
  const detailOf = (h: (typeof list)[number]) => (h.isDefault ? "default" : isAcpHarnessId(h.id) ? "ACP" : undefined);
  const trigger = (onClick?: () => void) => (
    <button type="button" class={barButtonClass} aria-label={`Agent: ${current.label}`} onClick={onClick}>
      <Bot />
      <span class="truncate">{current.label}</span>
      <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
    </button>
  );
  if (sheet) {
    return (
      <SheetPicker
        title="Agent"
        trigger={trigger}
        sections={[
          {
            items: list.map((h) => ({
              key: h.id,
              label: h.label,
              detail: detailOf(h),
              checked: h.id === current.id,
              onSelect: () => (newChatHarness.value = h.isDefault ? null : h.id),
            })),
          },
        ]}
      />
    );
  }
  return (
    <Menu side="top" contentClass="min-w-[220px]" trigger={trigger()}>
      {list.map((h) => (
        <MenuCheckItem
          key={h.id}
          checked={h.id === current.id}
          onSelect={() => (newChatHarness.value = h.isDefault ? null : h.id)}
          detail={detailOf(h)}
        >
          {h.label}
        </MenuCheckItem>
      ))}
    </Menu>
  );
}
