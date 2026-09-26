import { chats, projectsById } from "@/state/store";
import { setChatArchived } from "@/state/actions";
import { Button, FormGroup, FormRow } from "@/ui";
import { confirmDeleteChat } from "@/features/sidebar/ChatRow";
import { formatRelativeTime } from "@/features/sidebar/time";

export function ArchivedSettings() {
  const archived = chats.value.filter((c) => c.archived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return (
    <FormGroup footer="Archived chats are hidden from the sidebar. Unarchive one to continue it.">
      {archived.length === 0 ? (
        <FormRow label={<span class="text-fg-muted">No archived chats</span>} />
      ) : (
        archived.map((chat) => (
          <FormRow
            key={chat.id}
            label={chat.title || "Untitled"}
            description={`${chat.projectId ? (projectsById.value.get(chat.projectId)?.name ?? "Project") : "Chat"} · ${formatRelativeTime(chat.lastActivityAt)}`}
          >
            <Button size="sm" onClick={() => void setChatArchived(chat.id, false)}>
              Unarchive
            </Button>
            <Button size="sm" variant="ghost" class="text-danger" onClick={() => void confirmDeleteChat(chat)}>
              Delete…
            </Button>
          </FormRow>
        ))
      )}
    </FormGroup>
  );
}
