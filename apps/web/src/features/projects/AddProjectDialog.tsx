/**
 * "Create project" sheet: name the project and choose its source folder with the in-app folder
 * browser (ui/FolderBrowser, I-124), which lists folders of the project's environment through a
 * {@link ProjectFolderSource}. When that environment is this Mac, "Choose in Finder…" opens the
 * native dialog as an extra. Choosing a folder fills in the name unless the user typed one.
 *
 * Environment input: the `folders` prop (default: the local server). Everything environment-
 * specific goes through it; `create` (below) is the one other place that talks to a server.
 * I-123: with several environments connected the sheet asks which one the project belongs to
 * (fixed after creation); the folders and the create request then go to that environment.
 * The field is labelled "Device" (I-139, wording of I-136): "This Mac" and each device's name.
 */
import { useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Folder } from "lucide-preact";
import { routes } from "@/app/routes";
import { pickFolder } from "@/lib/native";
import { Button, Dialog, FolderBrowser, TextField } from "@/ui";
import { addProject } from "@/state/actions";
import { envIdOf, projects } from "@/state/store";
import { addProjectOpen } from "@/state/ui";
import { connections, primaryEnvironmentId, THIS_MACHINE_LABEL } from "@/state/env-registry";
import { Select } from "@/ui";
import { envFolderSource, type ProjectFolderSource } from "./folder-source";
import { SourceFolder } from "./SourceFolder";
import { folderName, nameAfterPick, validateProjectPath } from "./validation";

export interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (projectId: string) => void;
  /** The environment whose folders are browsed (default: the chosen environment's, I-123). */
  folders?: ProjectFolderSource;
}

export function AddProjectDialog({ open, onOpenChange, onAdded, folders: foldersProp }: AddProjectDialogProps) {
  /** The environment the project is created on (I-123); null = the local/primary one. */
  const [envId, setEnvId] = useState<string | null>(null);
  const folders = foldersProp ?? envFolderSource(envId);
  const envChoices = connections.value;
  const [name, setName] = useState("");
  /** The name we last filled in from a folder; a name equal to it may be replaced on re-pick. */
  const [autoName, setAutoName] = useState<string | null>(null);
  const [path, setPath] = useState("");
  /** The folder browser is shown (always while no folder is chosen). */
  const [browsing, setBrowsing] = useState(false);
  const [picking, setPicking] = useState(false);
  /** The native picker turned out to be unavailable (e.g. the server isn't on macOS). */
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const validation = validateProjectPath(path);
  const showBrowser = browsing || !path;
  const recent = projects.value.filter((p) => envIdOf(p) === (envId ?? primaryEnvironmentId())).map((p) => p.path);
  const nativePicker = folders.nativePicker && !nativeUnavailable;

  const reset = () => {
    setName("");
    setAutoName(null);
    setPath("");
    setBrowsing(false);
    setError(null);
    setEnvId(null);
  };
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) reset();
  };

  const chosen = (folder: string) => {
    const next = nameAfterPick(name, autoName, folder);
    if (next !== name) setAutoName(next);
    setName(next);
    setPath(folder);
    setBrowsing(false);
    setError(null);
  };

  const chooseInFinder = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const result = await pickFolder({ prompt: "Choose the project's source folder", defaultPath: path || undefined });
      if ("path" in result) chosen(result.path);
      else if ("unavailable" in result) setNativeUnavailable(true);
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
    if (validation || busy || picking || showBrowser) return;
    setBusy(true);
    try {
      const project = await addProject(path.trim(), name.trim() || undefined, envId ?? undefined);
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
      width={620}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("project-name")?.focus();
      }}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!!validation || busy || picking || showBrowser} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create project"}
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
              onChange={(id) => {
                setEnvId(id === primaryEnvironmentId() ? null : id);
                setPath("");
                setBrowsing(false);
              }}
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
          <button type="submit" hidden />
        </form>

        <div class="flex flex-col gap-1.5">
          <span class="font-medium">Source folder</span>
          {showBrowser ? (
            <FolderBrowser
              key={envId ?? ""}
              browse={folders.browse}
              mkdir={folders.mkdir}
              initialPath={path || "~"}
              recent={recent}
              onChoose={chosen}
              onCancel={path ? () => setBrowsing(false) : undefined}
              cancelLabel="Back"
            />
          ) : (
            <SourceFolder path={path} picking={picking} onPick={() => setBrowsing(true)} onRemove={remove} />
          )}
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 text-[0.92rem] text-fg-muted">Chats in this project run with this folder as their working directory.</span>
            {nativePicker && (
              <Button size="sm" variant="ghost" disabled={picking} onClick={() => void chooseInFinder()}>
                {picking ? "Choosing…" : "Choose in Finder…"}
              </Button>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" class="text-[0.92rem] text-danger">
            {error}
          </div>
        )}
      </div>
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
