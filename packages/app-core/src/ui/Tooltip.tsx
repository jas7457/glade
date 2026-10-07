import type { ComponentChildren } from "preact";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cn } from "@glade/app-core/lib/cn";
import { floatingSurfaceClass } from "./floating";

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

/**
 * Small native-looking tooltip. Requires <TooltipProvider> at the app root. Other props (e.g. from
 * an `asChild` trigger wrapping it, like <ContextMenu>) pass through to the child.
 */
export function Tooltip({ content, side = "bottom", children, ...rest }: TooltipProps & Record<string, unknown>) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild {...rest}>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          class={cn("z-50 rounded-[5px] px-1.5 py-[3px] text-[0.85rem] leading-snug select-none", floatingSurfaceClass)}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
