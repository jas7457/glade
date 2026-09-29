/** Friendly empty state for unknown chats/projects/pages. */
import { useNavigate } from "react-router";
import { SearchX } from "lucide-preact";
import { Button, Titlebar } from "@glade/app-core/ui";
import { routes } from "@glade/app-core/app/routes";

export function NotFound({ title = "Page not found", message }: { title?: string; message?: string }) {
  const navigate = useNavigate();
  return (
    <div class="flex h-full flex-col">
      <Titlebar />
      <div class="flex flex-1 flex-col items-center justify-center gap-2 pb-16 text-center">
        <SearchX size={36} strokeWidth={1.5} class="mb-1 text-fg-subtle" />
        <h1 class="text-[1.15rem] font-semibold">{title}</h1>
        {message && <p class="max-w-[320px] text-fg-muted">{message}</p>}
        <Button class="mt-3" onClick={() => navigate(routes.home())}>
          Start a New Chat
        </Button>
      </div>
    </div>
  );
}
