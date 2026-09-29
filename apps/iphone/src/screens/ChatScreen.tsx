/**
 * One chat, full screen (I-164 step 4, doc §5.3): `/e/:envId/chats/:chatId[?tab=<sessionId>]`.
 * Stub: the shared transcript + composer (ChatPane) under a back button.
 */
import { ChevronLeft } from "lucide-preact";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ChatPane } from "@/features/chat/ChatView";
import { resolveSessionId, workspacesById } from "@/state/store";
import { paths } from "~/app/routes";
import { NavBar, NavIconButton, Screen } from "~/ui/phone";

export function ChatScreen() {
  const { chatId = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const workspace = workspacesById.value.get(chatId);
  const sessionId = resolveSessionId(chatId, search.get("tab"));
  return (
    <Screen>
      <NavBar
        title={workspace?.title ?? "Chat"}
        left={
          <NavIconButton label="Chats" onClick={() => navigate(paths.home())}>
            <ChevronLeft size={26} />
          </NavIconButton>
        }
      />
      <div class="min-h-0 flex-1">{sessionId ? <ChatPane sessionId={sessionId} autoFocus={false} /> : null}</div>
    </Screen>
  );
}
