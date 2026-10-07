/**
 * A popover holding a keyboard-navigable list of rows with their own actions (I-203: the chat
 * header's bookmarks). Each row: an optional icon, a label with a muted second line, a muted
 * trailing note (e.g. a time) and action buttons that show while the row is highlighted (hover
 * or keyboard); right-clicking a row lists all its actions. A row can be renamed in place
 * (`editingId`): Return saves, Escape cancels, an empty name is passed on as "" (the caller
 * decides what that means).
 *
 * Keys: ↑/↓ move, Return picks (`onSelect`), Escape closes; `onRowKey` gets the other keys for
 * the highlighted row (e.g. ⌘C, ⌫). Opened by its owner (`open`); `anchor` is what it points at,
 * clicks on it don't count as "outside" (so a toggle button can close it).
 *
 *   <ListPopover open={open} onOpenChange={setOpen} anchor={<button …/>} title="Bookmarks"
 *                items={[{ id, label, detail, meta, actions: [{ id: "copy", label: "Copy", icon: <Copy /> }] }]}
 *                onSelect={(id) => …} onAction={(id, action) => …} />
 */
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@glade/app-core/lib/cn";
import { ContextMenu } from "./ContextMenu";
import { MenuItem, MenuSeparator } from "./Menu";
import { floatingSurfaceClass } from "./floating";
import { keepRowVisible } from "./list-scroll";
import { Tooltip } from "./Tooltip";

export interface ListPopoverAction {
  id: string;
  label: string;
  icon: ComponentChildren;
  destructive?: boolean;
  /** Only in the row's context menu, not as a button on the row. */
  menuOnly?: boolean;
  /** Shown in the context menu (`formatShortcut` text, e.g. "⌘C"). */
  shortcut?: string;
}

export interface ListPopoverItem {
  id: string;
  label: string;
  /** Muted second line. */
  detail?: ComponentChildren;
  /** Muted text at the trailing edge of the first line (hidden while the actions show). */
  meta?: ComponentChildren;
  icon?: ComponentChildren;
  actions?: ListPopoverAction[];
}

export interface ListPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the popover points at (e.g. the toolbar button that toggles it). */
  anchor: ComponentChildren;
  /** Header text (also the list's accessible name). */
  title: string;
  /** Muted text in the header's trailing edge (e.g. a key hint). */
  hint?: ComponentChildren;
  items: ListPopoverItem[];
  onSelect: (id: string) => void;
  onAction: (id: string, action: string) => void;
  /** The highlighted row's other keys; return true when handled. */
  onRowKey?: (e: KeyboardEvent, id: string) => boolean;
  /** Shown when there are no rows. */
  empty?: ComponentChildren;
  /** The row being renamed (its label becomes a field). */
  editingId?: string | null;
  /** Rename finished: the new name ("" = cleared), or `null` when cancelled. */
  onEditDone?: (id: string, value: string | null) => void;
  /** Placeholder of the rename field. */
  editPlaceholder?: string;
  align?: "start" | "center" | "end";
  width?: number;
}

export function ListPopover({
  open,
  onOpenChange,
  anchor,
  title,
  hint,
  items,
  onSelect,
  onAction,
  onRowKey,
  empty,
  editingId = null,
  onEditDone,
  editPlaceholder,
  align = "end",
  width = 340,
}: ListPopoverProps) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const index = items.length ? Math.min(active, items.length - 1) : -1;

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);
  useEffect(() => {
    if (open && index >= 0) keepRowVisible(list.current, document.getElementById(`${listId}-${index}`));
  }, [index, open]);
  // Back to the list after renaming, so the keys work again.
  useEffect(() => {
    if (open && editingId === null) list.current?.focus();
  }, [editingId]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (editingId !== null || e.isComposing) return;
    const move = (delta: number) => {
      e.preventDefault();
      if (items.length) setActive((index + delta + items.length) % items.length);
    };
    if (e.key === "ArrowDown") return move(1);
    if (e.key === "ArrowUp") return move(-1);
    const item = items[index];
    if (!item) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onSelect(item.id);
      return;
    }
    if (onRowKey?.(e, item.id)) e.preventDefault();
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>
        <span ref={anchorRef} class="inline-flex">
          {anchor}
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            list.current?.focus();
          }}
          // Escape while renaming cancels the rename only.
          onEscapeKeyDown={(e) => editingId !== null && e.preventDefault()}
          onInteractOutside={(e) => {
            // The anchor's own button toggles it; a row's context menu (its own layer) isn't outside.
            const target = e.target as Element | null;
            if (anchorRef.current?.contains(target) || target?.closest?.('[role="menu"]')) e.preventDefault();
          }}
          style={{ width: `${width}px` }}
          class={cn(
            "z-50 flex max-h-[min(460px,var(--radix-popover-content-available-height))] flex-col overflow-hidden rounded-[8px] text-[1rem] outline-none select-none",
            floatingSurfaceClass,
          )}
        >
          <div class="flex h-8 shrink-0 items-center gap-2 border-b border-separator px-3">
            <span class="flex-1 truncate font-semibold">{title}</span>
            {hint && <span class="shrink-0 text-[0.85rem] text-fg-subtle">{hint}</span>}
          </div>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={title}
            tabIndex={0}
            aria-activedescendant={index >= 0 && editingId === null ? `${listId}-${index}` : undefined}
            onKeyDown={onKeyDown}
            class="min-h-0 flex-1 overflow-y-auto p-[5px] outline-none"
          >
            {items.length === 0 && <div class="px-2 py-4 text-center text-fg-muted">{empty ?? "Nothing here"}</div>}
            {items.map((item, i) => (
              <Row
                key={item.id}
                id={`${listId}-${i}`}
                item={item}
                selected={i === index}
                editing={item.id === editingId}
                onHover={() => i !== index && setActive(i)}
                onSelect={() => onSelect(item.id)}
                onAction={(action) => onAction(item.id, action)}
                onEditDone={(value) => onEditDone?.(item.id, value)}
                editPlaceholder={editPlaceholder}
              />
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({
  id,
  item,
  selected,
  editing,
  onHover,
  onSelect,
  onAction,
  onEditDone,
  editPlaceholder,
}: {
  id: string;
  item: ListPopoverItem;
  selected: boolean;
  editing: boolean;
  onHover: () => void;
  onSelect: () => void;
  onAction: (action: string) => void;
  onEditDone: (value: string | null) => void;
  editPlaceholder?: string;
}) {
  const actions = item.actions ?? [];
  const buttons = actions.filter((a) => !a.menuOnly);
  const row = (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-highlighted={selected ? "" : undefined}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        // Keep the focus on the list (keys keep working); not while renaming.
        if (!editing) e.preventDefault();
      }}
      onClick={() => !editing && onSelect()}
      class={cn("group/row flex items-start gap-2 rounded-[5px] px-2 py-1.5", selected && "bg-selected")}
    >
      {item.icon && <span class="flex w-4 shrink-0 justify-center pt-[3px] text-fg-muted [&_svg]:size-3.5">{item.icon}</span>}
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="flex min-w-0 items-baseline gap-2">
          {editing ? (
            <RenameField value={item.label} placeholder={editPlaceholder} onDone={onEditDone} />
          ) : (
            <span class="min-w-0 flex-1 truncate font-medium">{item.label}</span>
          )}
          {item.meta && !editing && <span class={cn("shrink-0 text-[0.85rem] text-fg-subtle tabular-nums", selected && buttons.length > 0 && "invisible")}>{item.meta}</span>}
        </span>
        {item.detail && <span class="line-clamp-2 text-[0.88rem] leading-snug text-fg-muted">{item.detail}</span>}
      </span>
      {buttons.length > 0 && !editing && (
        <span class={cn("absolute top-1 right-1.5 flex items-center gap-0.5 rounded-[5px] bg-selected pl-1", !selected && "hidden")}>
          {buttons.map((a) => (
            <Tooltip key={a.id} content={a.label}>
              <button
                type="button"
                aria-label={a.label}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onAction(a.id);
                }}
                class={cn(
                  "inline-flex size-6 items-center justify-center rounded-[4px] text-fg-muted hover:bg-hover hover:text-fg [&_svg]:size-3.5",
                  a.destructive && "hover:text-danger",
                )}
              >
                {a.icon}
              </button>
            </Tooltip>
          ))}
        </span>
      )}
    </div>
  );
  if (!actions.length) return row;
  const destructive = actions.filter((a) => a.destructive);
  const rest = actions.filter((a) => !a.destructive);
  return (
    <div class="relative">
      <ContextMenu
        content={
          <>
            {rest.map((a) => (
              <MenuItem key={a.id} icon={a.icon} shortcut={a.shortcut} onSelect={() => onAction(a.id)}>
                {a.label}
              </MenuItem>
            ))}
            {destructive.length > 0 && rest.length > 0 && <MenuSeparator />}
            {destructive.map((a) => (
              <MenuItem key={a.id} icon={a.icon} shortcut={a.shortcut} destructive onSelect={() => onAction(a.id)}>
                {a.label}
              </MenuItem>
            ))}
          </>
        }
      >
        {row}
      </ContextMenu>
    </div>
  );
}

/** The label as a field: Return saves, Escape cancels (without closing the popover), blur saves. */
function RenameField({ value, placeholder, onDone }: { value: string; placeholder?: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? (ref.current?.value.trim() ?? "") : null);
  };
  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Name"
      placeholder={placeholder}
      spellcheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), finish(true));
        if (e.key === "Escape") (e.preventDefault(), finish(false));
      }}
      onBlur={() => finish(true)}
      class="h-[22px] min-w-0 flex-1 rounded-[4px] bg-control px-1.5 font-medium outline-none select-text shadow-[0_0_0_3px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)]"
    />
  );
}
