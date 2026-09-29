/**
 * iPhone UI primitives (I-164): the only place the phone layout makes raw styling decisions
 * (like packages/app-core/src/ui for the shared core). Native iOS feel: system font, 17px body, 44pt touch
 * targets, inset grouped lists, bottom sheets, safe-area insets (the page draws under the status
 * bar and home indicator: index.html sets viewport-fit=cover).
 */
import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { cn } from "@glade/app-core/lib/cn";

/** A full-height screen: nav bar on top, scrolling body. `grouped`: the tinted page behind inset grouped lists. */
export function Screen({ children, class: className, grouped }: { children: ComponentChildren; class?: string; grouped?: boolean }) {
  return <div class={cn("flex h-full min-h-0 flex-col text-[17px] text-fg", grouped ? "bg-grouped" : "bg-window", className)}>{children}</div>;
}

/** Top bar below the status bar: optional left/right slots and a centered title. */
export function NavBar({ title, left, right, large }: { title?: ComponentChildren; left?: ComponentChildren; right?: ComponentChildren; large?: boolean }) {
  return (
    <header class="shrink-0 select-none pt-[env(safe-area-inset-top)]">
      <div class="relative flex h-11 items-center justify-between px-2">
        <div class="z-10 flex min-w-11 items-center">{left}</div>
        {!large && title !== undefined && (
          <div class="pointer-events-none absolute inset-x-16 truncate text-center text-[17px] font-semibold text-fg-strong">{title}</div>
        )}
        <div class="z-10 flex min-w-11 items-center justify-end gap-1">{right}</div>
      </div>
      {large && title !== undefined && <h1 class="px-4 pb-2 text-[32px] leading-tight font-bold text-fg-strong">{title}</h1>}
    </header>
  );
}

/** Scrolling body of a screen (pads for the home indicator). */
export function ScreenBody({ children, class: className }: { children: ComponentChildren; class?: string }) {
  return <main class={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(env(safe-area-inset-bottom),16px)]", className)}>{children}</main>;
}

type ButtonKind = "filled" | "tinted" | "plain" | "danger";

export interface PhoneButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "class" | "size"> {
  kind?: ButtonKind;
  /** Full width (default for filled/tinted). */
  block?: boolean;
  class?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}

const KIND: Record<ButtonKind, string> = {
  filled: "bg-accent text-accent-fg active:opacity-80",
  tinted: "bg-accent/12 text-accent active:bg-accent/20",
  plain: "text-accent active:opacity-60",
  danger: "text-danger active:opacity-60",
};

export function PhoneButton({ kind = "filled", block, class: className, type = "button", ...rest }: PhoneButtonProps) {
  const full = block ?? (kind === "filled" || kind === "tinted");
  return (
    <button
      type={type}
      class={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-[17px] font-semibold select-none disabled:opacity-40",
        full && "w-full",
        KIND[kind],
        className,
      )}
      {...rest}
    />
  );
}

/** A 44×44 icon button for nav bars. */
export function NavIconButton({ label, children, onClick, class: className }: { label: string; children: ComponentChildren; onClick?: () => void; class?: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} class={cn("flex size-11 items-center justify-center rounded-full text-accent active:opacity-50", className)}>
      {children}
    </button>
  );
}

/** Inset grouped list section (iOS Settings style). */
export function ListGroup({ header, footer, children }: { header?: ComponentChildren; footer?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="mx-4 mb-6">
      {header && <h2 class="px-4 pb-1.5 text-[13px] text-fg-muted uppercase">{header}</h2>}
      <div class="overflow-hidden rounded-xl bg-cell [&>*+*]:border-t [&>*+*]:border-separator">{children}</div>
      {footer && <p class="px-4 pt-1.5 text-[13px] text-fg-muted">{footer}</p>}
    </section>
  );
}

export interface ListRowProps {
  icon?: ComponentChildren;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  detail?: ComponentChildren;
  onClick?: () => void;
  chevron?: boolean;
  tone?: "default" | "accent" | "danger";
}

export function ListRow({ icon, title, subtitle, detail, onClick, chevron, tone = "default" }: ListRowProps) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      class={cn(
        "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left select-none",
        onClick && "active:bg-hover",
        tone === "accent" && "text-accent",
        tone === "danger" && "text-danger",
      )}
    >
      {icon && <span class="flex size-7 shrink-0 items-center justify-center">{icon}</span>}
      <span class="min-w-0 flex-1">
        <span class="block truncate">{title}</span>
        {subtitle && <span class="block truncate text-[13px] text-fg-muted">{subtitle}</span>}
      </span>
      {detail && <span class="shrink-0 text-[15px] text-fg-muted">{detail}</span>}
      {chevron && <span class="shrink-0 text-fg-subtle" aria-hidden>›</span>}
    </Tag>
  );
}

/**
 * Bottom sheet over a dimmed backdrop (tap outside or Cancel closes it). iOS presents pickers and
 * small forms this way instead of popovers.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  action,
  full,
}: {
  open: boolean;
  onClose: () => void;
  title?: ComponentChildren;
  children: ComponentChildren;
  /** Right side of the sheet's header (e.g. a Done button). */
  action?: ComponentChildren;
  /** Nearly full height (lists); default: as tall as its content. */
  full?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div class="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <div class="absolute inset-0 bg-black/40 animate-[phone-fade_160ms_ease-out]" onClick={onClose} />
      <div
        class={cn(
          "relative flex max-h-[92%] flex-col rounded-t-2xl bg-grouped pb-[max(env(safe-area-inset-bottom),12px)] shadow-2xl animate-[phone-sheet-in_220ms_cubic-bezier(0.2,0.8,0.2,1)]",
          full && "h-[92%]",
        )}
      >
        <div class="mx-auto mt-2 h-1.5 w-9 shrink-0 rounded-full bg-fg-subtle/40" aria-hidden />
        <div class="relative flex h-12 shrink-0 items-center justify-between px-2">
          <PhoneButton kind="plain" onClick={onClose}>
            Cancel
          </PhoneButton>
          {title && <div class="pointer-events-none absolute inset-x-24 truncate text-center font-semibold text-fg-strong">{title}</div>}
          <div class="flex min-w-16 justify-end">{action}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}

/** Text input styled for the phone (16px+ so iOS doesn't zoom on focus). */
export function PhoneInput(props: JSX.InputHTMLAttributes<HTMLInputElement> & { class?: string }) {
  const { class: className, ...rest } = props;
  return <input {...rest} class={cn("h-11 w-full rounded-xl bg-cell px-4 text-[17px] text-fg outline-none placeholder:text-fg-subtle", className)} />;
}

export function PhoneTextArea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { class?: string }) {
  const { class: className, ...rest } = props;
  return <textarea {...rest} class={cn("w-full resize-none rounded-xl bg-cell px-4 py-3 text-[17px] text-fg outline-none placeholder:text-fg-subtle", className)} />;
}
