/**
 * New chat on the iPhone (I-164, reworked in I-166 to look like the chat screen): an empty state in
 * the middle (the leaf + "What should we work on?"), the shared floating glass composer at the
 * bottom in its new-chat mode (+, attachments, the Model & Thinking pill, and the agent as a third
 * section of that sheet when the Mac has several), and small chips just above it for the Mac (only
 * when more than one is connected) and the project (or none: a standalone chat in the Mac's
 * scratch folder). The first send creates the chat and replaces this screen with it.
 *
 *   /new                      the first connected Mac, no project
 *   /new?env=<id>&project=<id> preselected (e.g. a project's "+")
 */
import { useSignal } from "@preact/signals";
import { ChevronLeft, Folder, Laptop, MessageSquare } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate, useSearchParams } from "react-router";
import { Composer } from "@glade/app-core/features/chat/Composer";
import { shortenPath } from "@glade/app-core/features/chat/NewChatView";
import { OptionSheetContext } from "@glade/app-core/features/chat/option-sheet";
import { cn } from "@glade/app-core/lib/cn";
import { connections, type EnvHandle } from "@glade/app-core/state/env-registry";
import { remoteStateOf, remoteStateShort } from "@glade/app-core/state/remote-status";
import { envIdOf, sortedProjects } from "@glade/app-core/state/store";
import { useKeyboardViewport } from "~/chat/keyboard";
import { ContextChip, GladeLeaf } from "~/newchat/parts";
import { SheetList } from "~/ui/SheetList";
import { ListGroup, NavBar, NavIconButton, Sheet } from "~/ui/phone";
import { CheckRow } from "~/ui/phone-extra";

type Picker = "device" | "project" | null;

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
  const picker = useSignal<Picker>(null);
  const { height, keyboardOpen } = useKeyboardViewport();

  const envs = connections.value.filter((c) => !c.isLocal);
  const envId = defaultNewChatEnv(envChoice.value, envs);
  const env = envs.find((c) => c.id === envId);
  const connected = !!envId && remoteStateOf(envId) === "connected";
  const projects = sortedProjects.value.filter((p) => envIdOf(p) === envId);
  const project = projects.find((p) => p.id === projectChoice.value) ?? null;

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
  const offline = !connected && env ? `${env.name.value} is ${remoteStateShort(remoteStateOf(env.id))}` : undefined;

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
            <p class="mt-1.5 max-w-full text-[15px] text-fg-muted">
              {offline
                ? `${offline}. Chats can start once it's connected.`
                : project
                  ? shortenPath(project.path)
                  : `Standalone chats run in a scratch folder${env && envs.length > 1 ? ` on ${env.name.value}` : ""}.`}
            </p>
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
                icon={project ? <Folder size={15} /> : <MessageSquare size={15} />}
                label={project?.name ?? "No Project"}
                ariaLabel={`Project: ${project?.name ?? "none"}`}
                onClick={() => (picker.value = "project")}
              />
            </div>
            <Composer key={`${envId}:${project?.id ?? ""}`} projectId={project?.id ?? null} envId={project ? null : envId} autoFocus={false} replace lockedReason={offline ? `${offline}…` : undefined} />
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
              subtitle={remoteStateOf(c.id) === "connected" ? undefined : remoteStateShort(remoteStateOf(c.id))}
              checked={c.id === envId}
              onClick={() => {
                envChoice.value = c.id;
                if (c.id !== envId) projectChoice.value = null;
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
                icon={<Folder size={20} />}
                title={p.name}
                subtitle={shortenPath(p.path)}
                checked={p.id === project?.id}
                onClick={() => {
                  projectChoice.value = p.id;
                  close();
                }}
              />
            ))}
          </ListGroup>
        )}
      </Sheet>
    </OptionSheetContext.Provider>
  );
}
