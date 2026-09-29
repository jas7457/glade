/**
 * Home (I-164, doc §5.2): the chats across all connected Macs (`chats/ChatList`), with search.
 * Nav bar: Settings on the left, New Chat (+) on the right, large title "Chats".
 */
import { useSignal } from "@preact/signals";
import { Plus, Settings } from "lucide-preact";
import { useNavigate } from "react-router";
import { envIdOf } from "@glade/app-core/state/store";
import { paths } from "~/app/routes";
import { ChatList } from "~/chats/ChatList";
import { NavBar, NavIconButton, Screen, ScreenBody } from "~/ui/phone";
import { SearchField } from "~/ui/phone-extra";

export function HomeScreen() {
  const navigate = useNavigate();
  const query = useSignal("");
  return (
    <Screen grouped>
      <NavBar
        large
        title="Chats"
        left={
          <NavIconButton label="Settings" onClick={() => navigate(paths.settings())}>
            <Settings size={22} />
          </NavIconButton>
        }
        right={
          <NavIconButton label="New Chat" onClick={() => navigate(paths.newChat())}>
            <Plus size={24} />
          </NavIconButton>
        }
      />
      <div class="shrink-0 px-4 pb-3">
        <SearchField value={query.value} onInput={(v) => (query.value = v)} />
      </div>
      <ScreenBody>
        <ChatList
          query={query.value}
          onOpen={(chat) => navigate(paths.chat(envIdOf(chat), chat.id))}
          onOpenDevice={(id) => navigate(paths.device(id))}
          onNewChat={() => navigate(paths.newChat())}
        />
      </ScreenBody>
    </Screen>
  );
}
