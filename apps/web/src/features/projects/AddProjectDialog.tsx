/**
 * "Create project" sheet: name the project and choose its source folder with the native macOS
 * folder dialog (via {@link pickFolder}). Picking a folder fills in the name unless the user typed
 * one. When no native picker is available, the folder is typed as a path instead.
 */
import { useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Folder } from "lucide-preact";
import { routes } from "@/app/routes";
import { pickFolder } from "@/lib/native";
import { Button, Dialog, TextField } from "@/ui";
import { addProject } from "@/state/actions";
import { addProjectOpen } from "@/state/ui";
import { SourceFolder } from "./SourceFolder";
import { folderName, nameAfterPick, validateProjectPath } from "./validation";

export interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (projectId: string) => void;
}

export function AddProjectDialog({ open, onOpenChange, onAdded }: AddProjectDialogProps) {
  const [name, setName] = useState("");
  /** The name we last filled in from a folder; a name equal to it may be replaced on re-pick. */
  const [autoName, setAutoName] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  /** No native picker (non-macOS server): type the path instead. Remembered across opens. */
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const validation = validateProjectPath(path);
  const shownError = error ?? (manual && touched && path ? validation : null);

  const reset = () => {
    setName("");
    setAutoName(null);
    setPath("");
    setError(null);
    setTouched(false);
  };
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) reset();
  };

  const choose = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const result = await pickFolder({ prompt: "Choose the project's source folder", defaultPath: path || undefined });
      if ("path" in result) {
        const next = nameAfterPick(name, autoName, result.path);
        if (next !== name) setAutoName(next);
        setName(next);
        setPath(result.path);
      } else if ("unavailable" in result) {
        setManual(true);
        requestAnimationFrame(() => document.getElementById("project-path")?.focus());
      }
      // cancelled: leave everything as it was
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPicking(false);
    }
  };

  const remove = () => {
    if (name === autoName) setName("");
    setAutoName(null);
    setPath("");
    setError(null);
  };

  const submit = async () => {
    setTouched(true);
    if (validation || busy || picking) return;
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
      title="Create project"
      width={480}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("project-name")?.focus();
      }}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!!validation || busy || picking} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create project"}
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
          <label for="project-name" class="font-medium">
            Project name
          </label>
          <TextField
            id="project-name"
            leadingIcon={<Folder />}
            value={name}
            placeholder={path ? folderName(path) : "Project name"}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label for={manual ? "project-path" : undefined} class="font-medium">
            Source folder
          </label>
          {manual ? (
            <>
              <TextField
                id="project-path"
                mono
                value={path}
                invalid={!!shownError}
                placeholder="~/code/my-project"
                onInput={(e) => {
                  setPath(e.currentTarget.value);
                  setError(null);
                }}
                onBlur={() => setTouched(true)}
              />
              <span class="text-[0.92rem] text-fg-muted">The folder picker isn't available here. Enter the folder's path.</span>
            </>
          ) : (
            <SourceFolder path={path || null} picking={picking} onPick={() => void choose()} onRemove={remove} />
          )}
          <span class="text-[0.92rem] text-fg-muted">Chats in this project run with this folder as their working directory.</span>
        </div>

        {shownError && (
          <div role="alert" class="text-[0.92rem] text-danger">
            {shownError}
          </div>
        )}
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
