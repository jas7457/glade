/**
 * "Add Project" sheet: type/paste a path (supports ~) or browse for a folder, optionally name
 * it, then open the project's new-chat screen.
 */
import { useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { routes } from "@/app/routes";
import { Button, Dialog, TextField } from "@/ui";
import { addProject } from "@/state/actions";
import { addProjectOpen } from "@/state/ui";
import { FolderBrowser } from "./FolderBrowser";
import { folderName, validateProjectPath } from "./validation";

export interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (projectId: string) => void;
}

export function AddProjectDialog({ open, onOpenChange, onAdded }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const validation = validateProjectPath(path);
  const shownError = error ?? (touched && path ? validation : null);

  const reset = () => {
    setPath("");
    setName("");
    setBrowsePath(undefined);
    setSelected(null);
    setError(null);
    setTouched(false);
  };
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) reset();
  };

  const submit = async () => {
    setTouched(true);
    if (validation || busy) return;
    setBusy(true);
    try {
      const project = await addProject(path.trim(), name.trim() || undefined);
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
      title="Add Project"
      description="Chats in a project run with its folder as the working directory."
      width={520}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("project-path")?.focus();
      }}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!!validation || busy} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add Project"}
          </Button>
        </>
      }
    >
      <form
        class="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FolderBrowser
          path={browsePath}
          selected={selected}
          onNavigate={(p) => {
            setBrowsePath(p);
            setSelected(null);
          }}
          onSelect={(p) => {
            setSelected(p);
            if (p) {
              setPath(p);
              setError(null);
            }
          }}
          onLoaded={(l) => {
            if (!selected) {
              setPath(l.path);
              setError(null);
            }
          }}
        />
        <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <label for="project-path" class="text-right text-fg-muted">
            Folder
          </label>
          <TextField
            id="project-path"
            mono
            value={path}
            invalid={!!shownError}
            placeholder="~/code/my-project"
            onInput={(e) => {
              setPath(e.currentTarget.value);
              setSelected(null);
              setError(null);
            }}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => {
              // ⌥↩ jumps the browser to the typed folder instead of submitting.
              if (e.key === "Enter" && e.altKey && !validation) (e.preventDefault(), setBrowsePath(path.trim()));
            }}
          />
          <label for="project-name" class="text-right text-fg-muted">
            Name
          </label>
          <TextField id="project-name" value={name} placeholder={path ? folderName(path) : "Optional"} onInput={(e) => setName(e.currentTarget.value)} />
          {shownError && (
            <div role="alert" class="col-start-2 text-[0.92rem] text-danger">
              {shownError}
            </div>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Dialog bound to the global `addProjectOpen` signal; navigates to the new project. */
export function AddProjectHost() {
  const navigate = useNavigate();
  return (
    <AddProjectDialog
      open={addProjectOpen.value}
      onOpenChange={(o) => (addProjectOpen.value = o)}
      onAdded={(id) => navigate(routes.project(id))}
    />
  );
}
