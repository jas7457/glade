import type { ComponentChildren } from "preact";
import * as RadixTooltip from "@radix-ui/react-tooltip";

export function TooltipProvider({ children }: { children: ComponentChildren }) {
  return (
    <RadixTooltip.Provider delayDuration={600} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  content: ComponentChildren;
  side?: "top" | "bottom" | "left" | "right";
  children: ComponentChildren;
}

/** Small native-looking tooltip. Requires <TooltipProvider> at the app root. */
export function Tooltip({ content, side = "bottom", children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          class="z-50 rounded-[5px] bg-surface-raised px-2 py-1 text-[0.85rem] text-fg shadow-popover select-none"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
