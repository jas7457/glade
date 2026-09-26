// STUB - owned by the chat feature agent.
export function NewChatView({ projectId }: { projectId: string | null }) {
  return <div class="p-6 text-fg-muted">New chat {projectId ?? "(no project)"}</div>;
}
