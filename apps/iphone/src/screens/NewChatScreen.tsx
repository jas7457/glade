/**
 * New chat on the iPhone (I-164, reworked in I-166 to look like the chat screen): an empty state in
 * the middle (the leaf + "What should we work on?"), the shared floating glass composer at the
 * bottom in its new-chat mode (+, attachments, the Model & Thinking pill, and the agent as a third
 * section of that sheet when the Mac has several), and small chips just above it for the Mac (only
 * when more than one is connected) and the project (or none: a standalone chat in the Mac's
 * scratch folder). The first send creates the chat and replaces this screen with it.
 *
 * A group project (I-213, no folder of its own) adds a Folder chip: the new chat's folder, picked
 * from the group's chats' folders or the folder browser (newchat/group-folder.tsx). Nothing is sent
 * until one is chosen.
 *
 *   /new                      the first connected Mac, no project
 *   /new?env=<id>&project=<id> preselected (e.g. a project's "+")
 *   /new?…&folder=<id>        the chat starts in that sidebar folder (I-215: a folder's New Chat);
 *                             shown as "in <folder>", dropped when the Mac or project changes
 */
import { useSignal } from "@preact/signals";
import { ChevronLeft, FolderOpen, Laptop, MessageSquare } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate, useSearchParams } from "react-router";
import { Composer } from "@glade/app-core/features/chat/Composer";
import { shortenPath } from "@glade/app-core/features/chat/NewChatView";
import { OptionSheetContext } from "@glade/app-core/features/chat/option-sheet";
import { cn } from "@glade/app-core/lib/cn";
import { connections, type EnvHandle } from "@glade/app-core/state/env-registry";
import { remoteStateOf } from "@glade/app-core/state/remote-status";
import { isGroupProject, needsNewChatFolder, newChatFolderFor, resetNewChatFolder } from "@glade/app-core/state/new-chat-folder";
import { setNewChatInFolder } from "@glade/app-core/state/new-chat-in-folder";
import { envIdOf, foldersById, sortedProjects, workspaces } from "@glade/app-core/state/store";
import { baseName } from "@glade/app-core/ui/FolderBrowser";
import { ProjectIcon } from "@glade/app-core/ui/ProjectIcon";
import { useKeyboardViewport } from "~/chat/keyboard";
import { macStatusShort, macStatusTitle } from "~/lib/mac-status";
import { GroupFolderSheet, groupChatFolders } from "~/newchat/group-folder";
import { ContextChip, GladeLeaf } from "~/newchat/parts";
import { MacStatusNotice } from "~/ui/MacStatus";
import { SheetList } from "~/ui/SheetList";
import { ListGroup, NavBar, NavIconButton, Sheet } from "~/ui/phone";
import { CheckRow } from "~/ui/phone-extra";
import { VoiceButton } from "~/voice/VoiceButton";
import { openVoiceMode } from "~/voice/voice-mode";

type Picker = "device" | "project" | "folder" | null;

/** The Mac a new chat goes to: the requested one if connected, else the first connected one. */
export function defaultNewChatEnv(requested: string | null, list: readonly EnvHandle[] = connections.value): string | null {
  const usable = list.filter((c) => remoteStateOf(c.id) === "connected");
  if (requested && list.some((c) => c.id === requested)) return requested;
  return usable[0]?.id ?? list[0]?.id ?? null;
}

export function NewChatScreen() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const envChoice = useSignal<string | null>(search.get("env"));
  const projectChoice = useSignal<string | null>(search.get("project"));
  const folderChoice = useSignal<string | null>(search.get("folder"));
  const picker = useSignal<Picker>(null);
  const { height, keyboardOpen } = useKeyboardViewport();
  // Voice mode's first utterance starts the chat like Send (I-180).
  const startRef = useRef<((text: string) => Promise<string | null>) | null>(null);

  const envs = connections.value.filter((c) => !c.isLocal);
  const envId = defaultNewChatEnv(envChoice.value, envs);
  const env = envs.find((c) => c.id === envId);
  const connected = !!envId && remoteStateOf(envId) === "connected";
  const projects = sortedProjects.value.filter((p) => envIdOf(p) === envId);
  const project = projects.find((p) => p.id === projectChoice.value) ?? null;
  // Group project (I-213): the new chat's folder, and the folders its chats already use.
  const group = isGroupProject(project);
  const folder = project ? newChatFolderFor(project.id) : null;
  const needsFolder = needsNewChatFolder(project);
  const groupFolders = group && project ? groupChatFolders(project.id, workspaces.value) : [];
  // The choice belongs to this screen and project: forget it when either goes away.
  useEffect(() => resetNewChatFolder, [project?.id]);
  // I-215: the sidebar folder the chat starts in; only one of this Mac and project's list counts.
  const picked = folderChoice.value ? foldersById.value.get(folderChoice.value) : undefined;
  const inFolder = picked && envIdOf(picked) === envId && picked.projectId === (project?.id ?? null) ? picked : null;
  const inFolderId = inFolder?.id ?? null;
  useEffect(() => {
    setNewChatInFolder(inFolderId);
    return () => setNewChatInFolder(null);
  }, [inFolderId]);

  // The empty state stays centred in the space above the floating composer.
  const bottomRef = useRef<HTMLDivElement>(null);
  const [bottomHeight, setBottomHeight] = useState(0);
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBottomHeight(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const close = () => (picker.value = null);
  // I-170: "Can't reach Studio" (the notice says what to check, with Retry).
  const offline = !connected && env ? macStatusTitle(remoteStateOf(env.id), env.name.value) : undefined;

  return (
    <OptionSheetContext.Provider value={SheetList}>
      <div
        class="fixed inset-x-0 top-0 flex flex-col overflow-hidden bg-window text-[17px] text-fg"
        style={{ height: height ? `${height}px` : "100%" }}
        data-keyboard-open={keyboardOpen || undefined}
      >
        <NavBar
          title="New Chat"
          left={
            <NavIconButton label="Back" onClick={() => navigate(-1)}>
              <ChevronLeft size={26} />
            </NavIconButton>
          }
        />
        <div class="relative min-h-0 flex-1 border-t-[0.5px] border-separator">
          <div class="flex h-full flex-col items-center justify-center overflow-hidden px-8 text-center" style={{ paddingBottom: `${bottomHeight}px` }}>
            {!keyboardOpen && <GladeLeaf size={56} class="mb-4" />}
            <h1 class="text-[22px] font-semibold tracking-tight text-fg-strong">What should we work on?</h1>
            {offline && env ? (
              <MacStatusNotice envId={env.id} class="mt-4 w-full max-w-sm" />
            ) : (
              <p class="mt-1.5 max-w-full text-[15px] text-fg-muted">
                {project && group
                  ? folder
                    ? shortenPath(folder)
                    : "This group's chats each run in their own folder. Choose one to start."
                  : project?.path
                    ? shortenPath(project.path)
                    : `Standalone chats run in a scratch folder${env && envs.length > 1 ? ` on ${env.name.value}` : ""}.`}
                {inFolder && (
                  <span class="mt-0.5 block text-fg-subtle" data-testid="new-chat-folder">
                    in {inFolder.name}
                  </span>
                )}
              </p>
            )}
          </div>
          <div
            ref={bottomRef}
            class={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 px-2 pt-1 [&>*]:pointer-events-auto",
              keyboardOpen ? "pb-2" : "pb-[max(calc(env(safe-area-inset-bottom)_+_4px),16px)]",
            )}
          >
            <div class="mb-2 flex min-w-0 items-center gap-2 px-3">
              {envs.length > 1 && (
                <ContextChip icon={<Laptop size={15} />} label={env ? env.name.value : "No Mac"} ariaLabel={`Mac: ${env?.name.value ?? "none"}`} onClick={() => (picker.value = "device")} />
              )}
              <ContextChip
                icon={project ? <ProjectIcon project={project} size={15} /> : <MessageSquare size={15} />}
                label={project?.name ?? "No Project"}
                ariaLabel={`Project: ${project?.name ?? "none"}`}
                onClick={() => (picker.value = "project")}
              />
              {group && (
                <ContextChip
                  icon={<FolderOpen size={15} />}
                  label={folder ? baseName(folder) : <span class="text-accent">Choose Folder</span>}
                  ariaLabel={`Folder: ${folder ? baseName(folder) : "none"}`}
                  onClick={() => (picker.value = "folder")}
                />
              )}
            </div>
            <Composer key={`${envId}:${project?.id ?? ""}`} projectId={project?.id ?? null} envId={project ? null : envId} autoFocus={false}
              replace
              lockedReason={offline}
              startRef={startRef}
              sendAccessory={
                <VoiceButton
                  disabled={!!offline || needsFolder}
                  onClick={() =>
                    openVoiceMode({
                      kind: "new",
                      // A group chat can't start before its folder is chosen (I-213).
                      start: (text) => (needsNewChatFolder(project) ? Promise.resolve(null) : (startRef.current?.(text) ?? Promise.resolve(null))),
                    })
                  }
                />
              }
            />
          </div>
        </div>
      </div>

      <Sheet open={picker.value === "device"} onClose={close} title="Mac">
        <ListGroup>
          {envs.map((c) => (
            <CheckRow
              key={c.id}
              icon={<Laptop size={20} />}
              title={c.name.value}
              subtitle={remoteStateOf(c.id) === "connected" ? undefined : macStatusShort(remoteStateOf(c.id))}
              checked={c.id === envId}
              onClick={() => {
                envChoice.value = c.id;
                if (c.id !== envId) {
                  projectChoice.value = null;
                  folderChoice.value = null;
                }
                close();
              }}
            />
          ))}
        </ListGroup>
      </Sheet>

      <Sheet open={picker.value === "project"} onClose={close} title="Project" full={projects.length > 8}>
        <ListGroup>
          <CheckRow
            icon={<MessageSquare size={20} />}
            title="No Project"
            subtitle="A standalone chat"
            checked={!project}
            onClick={() => {
              if (project) folderChoice.value = null;
              projectChoice.value = null;
              close();
            }}
          />
        </ListGroup>
        {projects.length > 0 && (
          <ListGroup header="Projects">
            {projects.map((p) => (
              <CheckRow
                key={p.id}
                icon={<ProjectIcon project={p} size={20} />}
                title={p.name}
                subtitle={p.path === null ? "Group · each chat picks its folder" : shortenPath(p.path)}
                checked={p.id === project?.id}
                onClick={() => {
                  if (p.id !== project?.id) folderChoice.value = null;
                  projectChoice.value = p.id;
                  close();
                }}
              />
            ))}
          </ListGroup>
        )}
      </Sheet>

      {group && project && (
        <GroupFolderSheet open={picker.value === "folder"} onClose={close} projectId={project.id} envId={envId} folders={groupFolders} current={folder} />
      )}
    </OptionSheetContext.Provider>
  );
}
