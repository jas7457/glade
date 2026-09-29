/**
 * The chat list as an overlay over the current chat (I-164 step 5, doc §5.4): slides in from the
 * left (the chat screen opens it with its menu button or an edge swipe), about 85% wide over a
 * dimmed backdrop. Tap the backdrop, swipe it left or press Escape to close; tapping a chat opens
 * it and closes the overlay.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Plus, Settings } from "lucide-preact";
import { useNavigate, useParams } from "react-router";
import { envIdOf } from "@/state/store";
import { paths } from "~/app/routes";
import { NavIconButton } from "~/ui/phone";
import { SearchField } from "~/ui/phone-extra";
import { ChatList } from "./ChatList";

export interface SidebarOverlayProps {
  open: boolean;
  onClose: () => void;
}

/** Leftward drag (px) that closes the panel. */
const CLOSE_DISTANCE = 60;

export function SidebarOverlay({ open, onClose }: SidebarOverlayProps) {
  const navigate = useNavigate();
  const { chatId = null } = useParams();
  const query = useSignal("");
  const drag = useSignal(0);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    drag.value = 0;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (t) start.current = { x: t.clientX, y: t.clientY, horizontal: null };
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = start.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // Decide once whether this is a horizontal swipe or a scroll.
    if (s.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) s.horizontal = Math.abs(dx) > Math.abs(dy);
    if (s.horizontal) drag.value = Math.min(0, dx);
  };
  const onTouchEnd = () => {
    const closing = drag.value < -CLOSE_DISTANCE;
    start.current = null;
    drag.value = 0;
    if (closing) onClose();
  };

  return (
    <div class="fixed inset-0 z-40" data-sidebar-overlay>
      <div data-testid="sidebar-backdrop" class="absolute inset-0 bg-black/40 animate-[phone-fade_180ms_ease-out]" onClick={onClose} aria-hidden />
      <nav
        aria-label="Chats"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={drag.value ? { transform: `translateX(${drag.value}px)` } : undefined}
        class="absolute inset-y-0 left-0 flex w-[85%] max-w-[380px] flex-col bg-window pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] text-[17px] text-fg shadow-2xl animate-[phone-slide-in_240ms_cubic-bezier(0.2,0.8,0.2,1)]"
      >
        <div class="flex h-11 shrink-0 items-center justify-between px-2">
          <NavIconButton label="Settings" onClick={() => go(paths.settings())}>
            <Settings size={22} />
          </NavIconButton>
          <NavIconButton label="New Chat" onClick={() => go(paths.newChat())}>
            <Plus size={24} />
          </NavIconButton>
        </div>
        <h1 class="px-4 pb-2 text-[28px] leading-tight font-bold text-fg-strong select-none">Chats</h1>
        <SearchField class="mx-4 mb-3" value={query.value} onInput={(v) => (query.value = v)} />
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(env(safe-area-inset-bottom),16px)]">
          <ChatList
            query={query.value}
            selectedChatId={chatId}
            onOpen={(chat) => go(paths.chat(envIdOf(chat), chat.id))}
            onOpenDevice={(id) => go(paths.device(id))}
            onNewChat={() => go(paths.newChat())}
          />
        </div>
      </nav>
    </div>
  );
}
