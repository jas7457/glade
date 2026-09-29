/**
 * Add or edit a saved prompt (I-098): name (its `/` menu name is derived from it), optional
 * description, where it's offered (every chat or one project) and the text it inserts.
 *
 *   <PromptEditorDialog open onOpenChange={…} prompt={existing | null} initial={{ body, projectId }} />
 */
import { useEffect, useState } from "preact/hooks";
import { MAX_PROMPT_BODY, MAX_PROMPT_DESCRIPTION, MAX_PROMPT_NAME, promptCommandName, type SavedPrompt } from "@glade/protocol";
import { Button, Dialog, Select, TextArea, TextField } from "@glade/app-core/ui";
import { hostProjects as sortedProjects } from "@glade/app-core/state/host-settings";
import { addPrompt, updatePrompt, type PromptDraft } from "@glade/app-core/state/prompts";

const GLOBAL = "__global__";

export interface PromptEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this prompt; `null` = create a new one. */
  prompt: SavedPrompt | null;
  /** Initial values for a new prompt (e.g. the composer's text, the chat's project). */
  initial?: Partial<PromptDraft>;
}

export function PromptEditorDialog({ open, onOpenChange, prompt, initial }: PromptEditorDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<string>(GLOBAL);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const source = prompt ?? initial ?? {};
    setName(source.name ?? "");
    setDescription(source.description ?? "");
    setBody(source.body ?? "");
    setScope(source.projectId ?? GLOBAL);
    setBusy(false);
  }, [open, prompt]);

  const slug = promptCommandName(name);
  const valid = slug !== "" && body.trim() !== "";

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const draft: PromptDraft = { name, description, body, projectId: scope === GLOBAL ? null : scope };
    const ok = prompt ? await updatePrompt(prompt.id, draft) : (await addPrompt(draft)) !== null;
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  const projects = sortedProjects.value;
  const scopeOptions = [
    { value: GLOBAL, label: "All chats" },
    ...projects.map((p) => ({ value: p.id, label: p.name, group: "Project" })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={prompt ? "Edit prompt" : "New prompt"}
      width={520}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("prompt-name")?.focus();
      }}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {prompt ? "Save" : "Add prompt"}
          </Button>
        </>
      }
    >
      <form
        class="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="flex flex-col gap-1.5">
          <label for="prompt-name" class="font-medium">
            Name
          </label>
          <TextField
            id="prompt-name"
            value={name}
            maxLength={MAX_PROMPT_NAME}
            placeholder="Review diff"
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <p class="text-[0.92rem] text-fg-muted">
            {slug ? (
              <>
                Type <span class="font-mono text-fg">/{slug}</span> in the composer to insert it.
              </>
            ) : (
              "Shown in the composer's / menu."
            )}
          </p>
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="prompt-description" class="font-medium">
            Description <span class="font-normal text-fg-muted">(optional)</span>
          </label>
          <TextField
            id="prompt-description"
            value={description}
            maxLength={MAX_PROMPT_DESCRIPTION}
            onInput={(e) => setDescription(e.currentTarget.value)}
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="font-medium">Available in</span>
          <Select aria-label="Available in" value={scope} onChange={setScope} options={scopeOptions} class="self-start" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="prompt-body" class="font-medium">
            Prompt
          </label>
          <TextArea
            id="prompt-body"
            rows={8}
            value={body}
            maxLength={MAX_PROMPT_BODY}
            placeholder="Review this diff for bugs and missing tests…"
            onInput={(e) => setBody(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
      </form>
    </Dialog>
  );
}
