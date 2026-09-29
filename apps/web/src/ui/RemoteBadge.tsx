/**
 * RemoteBadge: the small, muted globe marking something that lives on *another* environment
 * (I-123 §5.1/§5.7: sidebar rows and the chat header; local items show nothing). Hovering or
 * clicking it shows a small popover with the environment's name, address and connection status.
 * A tiny status dot on the globe tells the status at a glance (I-142, {@link remoteStatusTone}).
 *
 *   <RemoteBadge name="Studio" address="http://127.0.0.1:5418" status="connected" />
 *
 * It's a `span` (it may sit inside a row's button); its click doesn't reach the row (so it
 * doesn't open the chat).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import * as Popover from "@radix-ui/react-popover";
import { Globe } from "lucide-preact";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { floatingSurfaceClass } from "./floating";
import { StatusDot, type StatusTone } from "./StatusDot";

/** The environment's state as the user sees it (I-132: `state/remote-status.ts`). */
export type RemoteStatus = "connecting" | "connected" | "remote-disabled" | "host-offline" | "unreachable" | "needs-pairing";

const STATUS_LABEL: Record<RemoteStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  "remote-disabled": "Remote access is turned off there",
  "host-offline": "Offline",
  unreachable: "Can't reach it",
  "needs-pairing": "Needs pairing",
};

const STATUS_TONE: Record<RemoteStatus, StatusTone> = {
  connecting: "pending",
  connected: "on",
  "remote-disabled": "off",
  "host-offline": "off",
  unreachable: "error",
  "needs-pairing": "error",
};

/** The status dot's colour for a remote status (I-142): green / amber / grey / red. */
export function remoteStatusTone(status: RemoteStatus): StatusTone {
  return STATUS_TONE[status];
}

export interface RemoteBadgeProps {
  /** The environment's name. */
  name: string;
  /** How it's reached (its origin). */
  address: string;
  status: RemoteStatus;
  /** Overrides the status line (e.g. "Remote access turned off on Studio"). */
  statusText?: string;
  /** A button under the status (e.g. "Pair again…"). */
  action?: { label: string; onSelect: () => void };
  /** Icon size in px (sidebar 12, header 13). */
  size?: number;
  class?: string;
}

const OPEN_DELAY = 350;
const CLOSE_DELAY = 150;

export function RemoteBadge({ name, address, status, statusText, action, size = 12, class: className }: RemoteBadgeProps) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => clearTimeout(timer.current);
  useEffect(() => clear, []);

  const hoverOpen = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clear();
    if (!open) timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const hoverClose = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clear();
    if (!pinned.current) timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        clear();
        pinned.current = next;
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <span
          role="button"
          tabIndex={-1}
          aria-label={`On ${name}`}
          data-remote-badge
          data-remote-status={status}
          class={cn(
            "relative inline-flex shrink-0 items-center justify-center rounded-[4px] text-fg-subtle outline-none hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/50",
            className,
          )}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (open && !pinned.current) {
              e.preventDefault();
              clear();
              pinned.current = true;
            }
          }}
        >
          <Globe size={size} strokeWidth={1.75} aria-hidden="true" class={cn(status !== "connected" && "opacity-60")} />
          <StatusDot tone={STATUS_TONE[status]} size={Math.max(4, Math.round(size / 3))} class="absolute -right-px -bottom-px" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Environment"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={clear}
          onPointerLeave={hoverClose}
          onClick={(e) => e.stopPropagation()}
          class={cn("z-50 max-w-[280px] rounded-[8px] px-3 py-2 text-[0.92rem] leading-snug outline-none select-none", floatingSurfaceClass)}
        >
          <div class="font-semibold text-fg-strong">{name}</div>
          <div class="selectable truncate text-fg-muted">{address}</div>
          <div class="mt-1 flex items-center gap-1.5 text-fg-muted">
            <StatusDot tone={STATUS_TONE[status]} />
            {statusText ?? STATUS_LABEL[status]}
          </div>
          {action && (
            <Button
              size="sm"
              class="mt-2"
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
