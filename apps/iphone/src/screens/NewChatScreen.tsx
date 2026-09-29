/**
 * New chat on the iPhone (I-164, doc §5.2): pick the Mac (only when more than one is connected),
 * the project (or none: a standalone chat in the Mac's scratch folder), optionally the agent and
 * model, then write the first message. Sending creates the chat (`createWorkspace`, like the
 * desktop's new-chat composer) and replaces this screen with it. Pickers are bottom sheets.
 *
 *   /new                      the first connected Mac, no project
 *   /new?env=<id>&project=<id> preselected (e.g. a project's "+")
 */
import { useSignal } from "@preact/signals";
import { ArrowUp, Bot, ChevronLeft, Folder, Laptop, MessageSquare, Sparkles } from "lucide-preact";
import { useNavigate, useSearchParams } from "react-router";
import { clampThinkingLevel, sameModel, type ModelRef } from "@glade/protocol";
import { shortenPath } from "@/features/chat/NewChatView";
import { connections, type EnvHandle } from "@/state/env-registry";
import { createWorkspace } from "@/state/actions";
import { defaultHarnessOf, harnessesOf } from "@/state/harnesses";
import { remoteStateOf, remoteStateShort } from "@/state/remote-status";
import { envIdOf, shellOf, sortedProjects, visibleModelsOf } from "@/state/store";
import { paths } from "~/app/routes";
import { ListGroup, ListRow, NavBar, NavIconButton, PhoneTextArea, Screen, ScreenBody, Sheet } from "~/ui/phone";
import { CheckRow } from "~/ui/phone-extra";

type Picker = "device" | "project" | "agent" | "model" | null;

const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;

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
  const harnessChoice = useSignal<string | null>(null);
  const modelChoice = useSignal<ModelRef | null>(null);
  const picker = useSignal<Picker>(null);
  const text = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

  const envs = connections.value.filter((c) => !c.isLocal);
  const envId = defaultNewChatEnv(envChoice.value, envs);
  const env = envs.find((c) => c.id === envId);
  const connected = !!envId && remoteStateOf(envId) === "connected";
  const projects = sortedProjects.value.filter((p) => envIdOf(p) === envId);
  const project = projects.find((p) => p.id === projectChoice.value) ?? null;

  // Agent + model, like the desktop's new-chat composer (Glade's default, else the harness's).
  const harnesses = harnessesOf(envId) ?? [];
  const harness = harnesses.find((h) => h.id === harnessChoice.value) ?? defaultHarnessOf(envId);
  const usesModels = harness?.capabilities.models !== false;
  const shell = shellOf(envId);
  const models = visibleModelsOf(shell);
  const defaults = shell.settings.value.models;
  const defaultModel = defaults.defaultModel && models.some((m) => sameModel(m, defaults.defaultModel)) ? defaults.defaultModel : null;
  const harnessModel = !defaultModel ? (shell.harnessDefaults.value?.model ?? null) : null;
  const picked = modelChoice.value && models.some((m) => sameModel(m, modelChoice.value)) ? modelChoice.value : null;
  const model: ModelRef | null = picked ?? defaultModel ?? harnessModel ?? (models[0] ? { provider: models[0].provider, id: models[0].id } : null);
  const followsHarness = !picked && !defaultModel && harnessModel !== null;
  const info = models.find((m) => sameModel(m, model)) ?? shell.models.value.find((m) => sameModel(m, model));
  const modelLabel = !usesModels ? "Chosen by the agent" : picked ? (info?.name ?? model?.id) : `Default${info ? ` (${info.name})` : ""}`;

  const canSend = connected && !!text.value.trim() && !busy.value;

  const send = async () => {
    if (!canSend || !envId) return;
    busy.value = true;
    error.value = null;
    try {
      const levels = info?.thinkingLevels ?? ["off"];
      const level = followsHarness ? (shell.harnessDefaults.value?.thinkingLevel ?? defaults.defaultThinkingLevel) : defaults.defaultThinkingLevel;
      const created = await createWorkspace(
        {
          projectId: project?.id ?? null,
          prompt: text.value.trim(),
          model: followsHarness || !usesModels ? null : model,
          thinkingLevel: model && usesModels ? clampThinkingLevel(levels, level) : null,
          ...(harness && !harness.isDefault ? { harness: harness.id } : {}),
        },
        envId,
      );
      navigate(paths.chat(envId, created.workspace.id), { replace: true });
    } catch (err) {
      error.value = `Could not start the chat: ${(err as Error).message}`;
    } finally {
      busy.value = false;
    }
  };

  const close = () => (picker.value = null);

  return (
    <Screen>
      <NavBar
        title="New Chat"
        left={
          <NavIconButton label="Back" onClick={() => navigate(-1)}>
            <ChevronLeft size={26} />
          </NavIconButton>
        }
      />
      <ScreenBody class="pt-2">
        <ListGroup footer={project ? shortenPath(project.path) : "Standalone chats run in a scratch folder on the Mac."}>
          {envs.length > 1 && (
            <ListRow
              icon={<Laptop size={20} class="text-fg-muted" />}
              title="Device"
              detail={env ? env.name.value : "None"}
              chevron
              onClick={() => (picker.value = "device")}
            />
          )}
          <ListRow icon={<Folder size={20} class="text-fg-muted" />} title="Project" detail={project?.name ?? "No Project"} chevron onClick={() => (picker.value = "project")} />
          {harnesses.length > 1 && <ListRow icon={<Bot size={20} class="text-fg-muted" />} title="Agent" detail={harness?.label ?? "Default"} chevron onClick={() => (picker.value = "agent")} />}
          {usesModels && models.length > 0 && <ListRow icon={<Sparkles size={20} class="text-fg-muted" />} title="Model" detail={modelLabel} chevron onClick={() => (picker.value = "model")} />}
        </ListGroup>

        {!connected && env && <p class="mx-8 mb-4 text-center text-[15px] text-fg-muted">{env.name.value} is {remoteStateShort(remoteStateOf(env.id))}. Chats can start once it's connected.</p>}

        <form
          class="mx-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <PhoneTextArea
            aria-label="Message"
            rows={4}
            placeholder={project ? `What should we work on in ${project.name}?` : "Ask anything…"}
            value={text.value}
            onInput={(e) => (text.value = (e.currentTarget as HTMLTextAreaElement).value)}
            class="min-h-28 border border-separator"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={!canSend}
            class="mb-1 flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg active:opacity-80 disabled:opacity-40"
          >
            <ArrowUp size={22} strokeWidth={2.5} />
          </button>
        </form>
        {error.value && (
          <p role="alert" class="mx-6 mt-3 text-[15px] text-danger">
            {error.value}
          </p>
        )}
      </ScreenBody>

      <Sheet open={picker.value === "device"} onClose={close} title="Device">
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
                if (c.id !== envId) {
                  projectChoice.value = null;
                  harnessChoice.value = null;
                  modelChoice.value = null;
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

      <Sheet open={picker.value === "agent"} onClose={close} title="Agent">
        <ListGroup>
          {harnesses.map((h) => (
            <CheckRow
              key={h.id}
              title={h.label}
              subtitle={h.isDefault ? "Default" : undefined}
              checked={h.id === harness?.id}
              onClick={() => {
                harnessChoice.value = h.id;
                close();
              }}
            />
          ))}
        </ListGroup>
      </Sheet>

      <Sheet open={picker.value === "model"} onClose={close} title="Model" full={models.length > 8}>
        <ListGroup>
          <CheckRow
            title="Default"
            subtitle={!picked && info ? info.name : undefined}
            checked={!picked}
            onClick={() => {
              modelChoice.value = null;
              close();
            }}
          />
          {models.map((m) => (
            <CheckRow
              key={modelKey(m)}
              title={m.name}
              subtitle={m.provider}
              checked={!!picked && sameModel(m, picked)}
              onClick={() => {
                modelChoice.value = { provider: m.provider, id: m.id };
                close();
              }}
            />
          ))}
        </ListGroup>
      </Sheet>
    </Screen>
  );
}
