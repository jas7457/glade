/**
 * Settings → Prompts (I-098): the user's saved prompts, grouped by where they're offered (every
 * chat, or one project's chats). Add, edit, delete, and move up/down within a group. Stored in
 * `settings.prompts` (Glade's data folder, never the repo); see state/prompts.ts.
 */
import { useState } from "preact/hooks";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-preact";
import { promptCommandName, type SavedPrompt } from "@glade/protocol";
import { Button, FormGroup, FormRow, IconButton, confirm } from "@glade/app-core/ui";
import { hostProjects as sortedProjects, hostSettings as settings } from "@glade/app-core/state/host-settings";
import { deletePrompt, movePrompt } from "@glade/app-core/state/prompts";
import { PromptEditorDialog } from "./PromptEditorDialog";

interface PromptGroup {
  projectId: string | null;
  title: string;
  prompts: SavedPrompt[];
}

/** "All Chats" first, then each project with prompts, in the sidebar's project order. */
export function groupPrompts(prompts: readonly SavedPrompt[], projects: readonly { id: string; name: string }[]): PromptGroup[] {
  const groups: PromptGroup[] = [{ projectId: null, title: "All Chats", prompts: prompts.filter((p) => p.projectId === null) }];
  for (const project of projects) {
    const own = prompts.filter((p) => p.projectId === project.id);
    if (own.length) groups.push({ projectId: project.id, title: project.name, prompts: own });
  }
  return groups;
}

function preview(prompt: SavedPrompt): string {
  return prompt.description || prompt.body.trim().split("\n")[0] || "";
}

export function PromptSettings() {
  const prompts = settings.value.prompts ?? [];
  const groups = groupPrompts(prompts, sortedProjects.value);
  const [editing, setEditing] = useState<{ prompt: SavedPrompt | null; projectId: string | null } | null>(null);

  const remove = async (prompt: SavedPrompt) => {
    const ok = await confirm({
      title: "Delete prompt?",
      subject: prompt.name,
      message: "will be deleted. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) await deletePrompt(prompt.id);
  };

  return (
    <>
      <p class="mb-4 text-fg-muted">
        Reusable prompts you can insert from the composer: type <span class="font-mono">/</span> and pick one from Saved Prompts. Picking a
        prompt puts its text in the composer so you can edit it before sending.
      </p>
      <div class="mb-5 flex items-center">
        <Button size="sm" onClick={() => setEditing({ prompt: null, projectId: null })}>
          <Plus size={12} />
          New Prompt
        </Button>
      </div>
      {groups.map((group) => (
        <FormGroup
          key={group.projectId ?? "global"}
          title={group.title}
          footer={group.projectId === null ? "Offered in every chat. Prompts for one project are only offered in its chats." : undefined}
          actions={
            <Button size="sm" variant="ghost" aria-label={`Add prompt to ${group.title}`} onClick={() => setEditing({ prompt: null, projectId: group.projectId })}>
              Add
            </Button>
          }
        >
          {group.prompts.length === 0 && <FormRow label={<span class="text-fg-muted">No prompts yet.</span>} />}
          {group.prompts.map((prompt, i) => (
            <FormRow
              key={prompt.id}
              label={
                <span>
                  <span class="font-medium">{prompt.name}</span>
                  <span class="ml-2 font-mono text-[0.9rem] text-fg-subtle">/{promptCommandName(prompt.name)}</span>
                </span>
              }
              description={<span class="line-clamp-2 [overflow-wrap:anywhere]">{preview(prompt)}</span>}
            >
              <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => void movePrompt(prompt.id, -1)}>
                <ChevronUp size={14} />
              </IconButton>
              <IconButton size="sm" label="Move down" disabled={i === group.prompts.length - 1} onClick={() => void movePrompt(prompt.id, 1)}>
                <ChevronDown size={14} />
              </IconButton>
              <IconButton size="sm" label={`Edit ${prompt.name}`} onClick={() => setEditing({ prompt, projectId: prompt.projectId })}>
                <Pencil size={13} />
              </IconButton>
              <IconButton size="sm" label={`Delete ${prompt.name}`} onClick={() => void remove(prompt)}>
                <Trash2 size={13} />
              </IconButton>
            </FormRow>
          ))}
        </FormGroup>
      ))}
      <PromptEditorDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        prompt={editing?.prompt ?? null}
        initial={{ projectId: editing?.projectId ?? null }}
      />
    </>
  );
}
