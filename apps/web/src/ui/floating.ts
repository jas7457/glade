/**
 * The look shared by every floating surface (tooltips, menus, context menus, popovers, the slash
 * menu, the command palette): the `popover` background token, a hairline border and the
 * `floating` shadow from styles.css, so they read as a separate layer above whatever they cover
 * (e.g. a tooltip over the composer). Compose with size/padding/radius classes:
 *
 *   <div class={cn(floatingSurfaceClass, "rounded-[8px] p-2")}>…</div>
 */
export const floatingSurfaceClass = "bg-popover text-fg ring-1 ring-popover-border shadow-floating";
