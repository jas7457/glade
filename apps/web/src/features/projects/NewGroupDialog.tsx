/**
 * "New Group" sheet (I-213): a group project is a project with only a name, no folder of its own;
 * each chat in it picks its own folder when it's created. The sheet asks for the name (and, with
 * several environments connected, the device the group's chats run on, like Create Project).
 */
import { useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { routes } from "@glade/app-core/app/routes";
import { Button, Dialog, ProjectIcon, Select, TextField } from "@glade/app-core/ui";
import { addGroup } from "@glade/app-core/state/actions";
import { newGroupOpen } from "@glade/app-core/state/ui";
import { connections, primaryEnvironmentId, THIS_MACHINE_LABEL } from "@glade/app-core/state/env-registry";

export interface NewGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (projectId: string) => void;
}

export function NewGroupDialog({ open, onOpenChange, onAdded }: NewGroupDialogProps) {
  const [envId, setEnvId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const envChoices = connections.value;

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setName("");
      setError(null);
      setEnvId(null);
    }
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const project = await addGroup(trimmed, envId ?? undefined);
      close(false);
      onAdded?.(project.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New group"
      width={420}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("group-name")?.focus();
      }}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create group"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-4">
        {envChoices.length > 1 && (
          <div class="flex flex-col gap-1.5">
            <span class="font-medium">Device</span>
            <Select
              aria-label="Device"
              value={envId ?? primaryEnvironmentId()}
              onChange={(id) => setEnvId(id === primaryEnvironmentId() ? null : id)}
              options={envChoices.map((c) => ({ value: c.id, label: c.isLocal ? THIS_MACHINE_LABEL : c.name.value }))}
            />
          </div>
        )}
        <form
          class="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label for="group-name" class="font-medium">
            Group name
          </label>
          <TextField
            id="group-name"
            leadingIcon={<ProjectIcon project={{ path: null }} />}
            value={name}
            placeholder="Group name"
            onInput={(e) => {
              setName(e.currentTarget.value);
              setError(null);
            }}
          />
          <span class="text-[0.92rem] text-fg-muted">A group has no folder of its own: each chat in it picks its folder when you start it.</span>
          <button type="submit" hidden />
        </form>
        {error && (
          <div role="alert" class="text-[0.92rem] text-danger">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Dialog bound to the global `newGroupOpen` signal; opens the new group's new-chat screen. */
export function NewGroupHost() {
  const navigate = useNavigate();
  return <NewGroupDialog open={newGroupOpen.value} onOpenChange={(o) => (newGroupOpen.value = o)} onAdded={(id) => navigate(routes.project(id))} />;
}
