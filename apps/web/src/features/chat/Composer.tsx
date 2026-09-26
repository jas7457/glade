/**
 * Message composer. Reusable anywhere:
 *
 *   <Composer chatId="…" />              existing chat: prompts, queues while running, stop
 *   <Composer projectId={id | null} />   "new" mode: creates the chat on first send and
 *                                        navigates to it (needs a router)
 *
 * Both are thin wrappers around <ComposerBox>, which owns the textarea, attachments, send
 * keys, toolbar and the slash-command menu but none of the data flow.
 *
 * Slash commands: typing `/` at the start opens a menu of pi-ui built-ins (slash/builtins.ts,
 * run here in the browser) plus the chat's harness commands (sent to the agent as a prompt).
 */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { ArrowUp, Paperclip, Square, TriangleAlert, X } from "lucide-preact";
import {
  DEFAULT_IMAGE_LIMITS,
  clampThinkingLevel,
  sameModel,
  type ModelInfo,
  type ModelRef,
  type PromptImage,
  type SlashCommand,
  type ThinkingLevel,
} from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { chatPath } from "@/app/routes";
import { applyChatDetail, loadChatCommands, runAction, useChatSession } from "@/state/chat-session";
import { settings, visibleModels } from "@/state/store";
import { notify } from "@/state/toasts";
import { Spinner, Tooltip } from "@/ui";
import { imageFiles, isSendKey, readImageFile, type Attachment } from "./composer-utils";
import { ContextMeter } from "./ContextMeter";
import { ModelPicker, ThinkingPicker } from "./Pickers";
import { UiRequestCard } from "./UiRequestCard";
import { builtinCommands, findBuiltin, type SlashContext } from "./slash/builtins";
import { filterCommands, mergeCommands, parseSlash } from "./slash/match";
import { SLASH_MENU_ID, SlashMenu, slashOptionId } from "./slash/SlashMenu";

// ---------------------------------------------------------------------------------------------
// Drafts survive switching chats (in memory).
// ---------------------------------------------------------------------------------------------

const drafts = new Map<string, string>();

// ---------------------------------------------------------------------------------------------
// Presentational composer
// ---------------------------------------------------------------------------------------------

/** Enables the slash-command menu. */
export interface ComposerSlashOptions {
  /** Everything the menu offers: built-ins (source "builtin") + harness commands. */
  commands: SlashCommand[];
  chatId: string | null;
  projectId: string | null;
  navigate: (path: string) => void;
}

export interface ComposerBoxProps {
  /** Key for draft persistence. */
  draftKey: string;
  placeholder?: string;
  autoFocus?: boolean;
  isRunning?: boolean;
  /** Disable input (e.g. while creating a chat). */
  busy?: boolean;
  supportsImages: boolean;
  model: ModelRef | null;
  models: ModelInfo[];
  onModelChange: (model: ModelRef) => void;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  onThinkingChange: (level: ThinkingLevel) => void;
  /** Resolve true to clear the input. */
  onSend: (text: string, images: PromptImage[]) => Promise<boolean>;
  onStop?: () => void;
  /** Rendered above the input box (queue chips, dialogs, banners). */
  above?: ComponentChildren;
  /** Extra toolbar items after the pickers (e.g. the context meter). */
  toolbarExtra?: ComponentChildren;
  slash?: ComposerSlashOptions;
  class?: string;
}

export function ComposerBox(props: ComposerBoxProps) {
  const { draftKey, isRunning = false, busy = false, supportsImages } = props;
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [images, setImages] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openPicker, setOpenPicker] = useState<"model" | "thinking" | null>(null);
  const pickerFromSlash = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendKey = settings.value.general.sendKey;
  const slash = props.slash;

  // Slash menu: open while typing a command name at the very start of the text.
  const parsed = slash ? parseSlash(text) : null;
  const typingName = parsed && !parsed.hasArgs ? parsed.name : null;
  const groups = useMemo(() => (slash && typingName !== null ? filterCommands(slash.commands, typingName) : []), [slash?.commands, typingName]);
  const flat = groups.flatMap((g) => g.commands);
  const menuOpen = typingName !== null && !menuDismissed && !busy && flat.length > 0;
  const active = Math.min(activeIndex, Math.max(0, flat.length - 1));

  useEffect(() => setActiveIndex(0), [typingName]);
  useEffect(() => {
    if (typingName === null) setMenuDismissed(false);
  }, [typingName === null]);

  // Switch drafts when the composer is reused for another chat.
  useEffect(() => {
    setText(drafts.get(draftKey) ?? "");
    setImages([]);
  }, [draftKey]);

  useEffect(() => {
    if (props.autoFocus !== false) textareaRef.current?.focus();
  }, [draftKey]);

  // Auto-grow up to 40% of the viewport.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const updateText = (value: string) => {
    setText(value);
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (!supportsImages) {
      notify("warning", "The selected model doesn't accept images.");
      return;
    }
    try {
      const limits = modelInfo(props.models, props.model)?.imageLimits ?? DEFAULT_IMAGE_LIMITS;
      const read = await Promise.all(files.map((file) => readImageFile(file, limits)));
      setImages((prev) => [...prev, ...read]);
    } catch (err) {
      notify("error", `Could not attach image: ${(err as Error).message}`);
    }
  };

  const canSend = !busy && (text.trim().length > 0 || images.length > 0);

  /** Insert `/name ` and keep typing arguments. */
  const complete = (command: SlashCommand) => {
    updateText(`/${command.name} `);
    setMenuDismissed(false);
    textareaRef.current?.focus();
  };

  const pickerProps = (which: "model" | "thinking") => ({
    open: openPicker === which,
    onOpenChange: (open: boolean) => {
      if (!open && openPicker !== which) return;
      setOpenPicker(open ? which : null);
    },
    onCloseAutoFocus: (e: Event) => {
      if (!pickerFromSlash.current) return;
      // Opened from a slash command: return to the textarea, not the picker button.
      pickerFromSlash.current = false;
      e.preventDefault();
      textareaRef.current?.focus();
    },
  });

  /** The built-in command `sentText` invokes, if any (only those this composer offers). */
  const builtinFor = (sentText: string) => {
    const cmd = slash ? parseSlash(sentText) : null;
    if (!slash || !cmd || !slash.commands.some((c) => c.source === "builtin" && c.name === cmd.name)) return null;
    const builtin = findBuiltin(cmd.name);
    return builtin ? { builtin, args: cmd.args, slash } : null;
  };

  const runBuiltin = async ({ builtin, args, slash }: NonNullable<ReturnType<typeof builtinFor>>): Promise<boolean> => {
    const ctx: SlashContext = {
      chatId: slash.chatId,
      projectId: slash.projectId,
      navigate: slash.navigate,
      models: props.models,
      thinkingLevels: props.thinkingLevels,
      setModel: props.onModelChange,
      setThinkingLevel: props.onThinkingChange,
      openPicker: (which) => {
        pickerFromSlash.current = true;
        setOpenPicker(which);
      },
    };
    try {
      return await builtin.run(args, ctx);
    } catch (err) {
      notify("error", `/${builtin.name} failed: ${(err as Error).message}`);
      return false;
    }
  };

  const send = async () => {
    if (!canSend) return;
    const sentText = text.trim();
    const sentImages = images;
    const builtin = builtinFor(sentText);
    if (builtin) {
      // Runs here instead of being sent (attached images stay for the next message).
      const typed = text;
      updateText("");
      if (!(await runBuiltin(builtin))) updateText(typed);
      return;
    }
    // Optimistically clear; restore if it failed.
    updateText("");
    setImages([]);
    const ok = await props.onSend(
      sentText,
      sentImages.map(({ mimeType, data }) => ({ mimeType, data })),
    );
    if (!ok) {
      updateText(sentText);
      setImages(sentImages);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const composing = e.isComposing || e.keyCode === 229;
    if (menuOpen && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((active + step + flat.length) % flat.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        complete(flat[active]!);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const command = flat[active]!;
        // Fully typed: run/send it. Otherwise complete the highlighted command first.
        if (command.name === typingName) void send();
        else complete(command);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (isSendKey(e, sendKey)) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === "Escape" && isRunning && props.onStop) {
      e.preventDefault();
      props.onStop();
    }
  };

  return (
    <div class={cn("w-full", props.class)}>
      {props.above}
      <div
        class={cn(
          "relative flex flex-col rounded-[14px] bg-surface-raised shadow-[0_0_0_0.5px_var(--pi-separator),0_2px_10px_-4px_rgb(0_0_0/0.12)] transition-shadow focus-within:shadow-[0_0_0_0.5px_var(--pi-fg-subtle),0_2px_12px_-4px_rgb(0_0_0/0.16)]",
          dragging && "shadow-[0_0_0_2px_var(--pi-accent)]",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          const files = imageFiles(e.dataTransfer?.files);
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
      >
        {menuOpen && <SlashMenu groups={groups} activeIndex={active} onHover={setActiveIndex} onPick={complete} />}
        {images.length > 0 && (
          <div class="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments">
            {images.map((img) => (
              <div key={img.id} class="group/att relative">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  class="size-14 rounded-[8px] border-[0.5px] border-separator object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove ${img.name}`}
                  onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}
                  class="absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-fg text-window opacity-0 shadow group-hover/att:opacity-100 focus-visible:opacity-100"
                >
                  <X size={11} strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={busy}
          placeholder={props.placeholder ?? (isRunning ? "Queue a message…" : "Ask anything…")}
          aria-label="Message"
          aria-autocomplete={slash ? "list" : undefined}
          aria-expanded={slash ? menuOpen : undefined}
          aria-controls={menuOpen ? SLASH_MENU_ID : undefined}
          aria-activedescendant={menuOpen ? slashOptionId(active) : undefined}
          class="selectable block max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[1rem] leading-[1.5] text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none disabled:opacity-60"
          onInput={(e) => updateText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData?.files);
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        />
        <div class="flex items-center gap-1 px-2 pt-1 pb-2">
          {supportsImages && (
            <>
              <Tooltip content="Attach images">
                <button
                  type="button"
                  aria-label="Attach images"
                  class="inline-flex size-6 items-center justify-center rounded-control text-fg-muted hover:bg-hover hover:text-fg"
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={14} />
                </button>
              </Tooltip>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(imageFiles(e.currentTarget.files));
                  e.currentTarget.value = "";
                }}
              />
            </>
          )}
          <ModelPicker
            value={props.model}
            models={props.models}
            onChange={props.onModelChange}
            disabled={busy}
            {...pickerProps("model")}
          />
          <ThinkingPicker
            value={props.thinkingLevel}
            levels={props.thinkingLevels}
            onChange={props.onThinkingChange}
            disabled={busy}
            {...pickerProps("thinking")}
          />
          {props.toolbarExtra}
          <div class="flex-1" />
          {busy && <Spinner size={14} class="mr-1" />}
          {isRunning && props.onStop && (
            <Tooltip content="Stop (Esc)">
              <button
                type="button"
                aria-label="Stop"
                onClick={props.onStop}
                class="flex size-7 items-center justify-center rounded-full bg-fg text-window hover:opacity-85"
              >
                <Square size={10} fill="currentColor" strokeWidth={0} />
              </button>
            </Tooltip>
          )}
          {(!isRunning || canSend) && (
            <button
              type="button"
              aria-label={isRunning ? "Queue message" : "Send"}
              disabled={!canSend}
              onClick={() => void send()}
              class="flex size-7 items-center justify-center rounded-full bg-accent text-accent-fg hover:brightness-110 disabled:bg-fg-subtle/40 disabled:text-window"
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Existing chat
// ---------------------------------------------------------------------------------------------

function modelInfo(models: ModelInfo[], ref: ModelRef | null): ModelInfo | undefined {
  return ref ? models.find((m) => sameModel(m, ref)) : undefined;
}

function supportsImageInput(info: ModelInfo | undefined): boolean {
  // Unknown model (list not loaded yet): allow; the agent will reject if unsupported.
  return info ? info.input.includes("image") : true;
}

export interface ChatComposerProps {
  chatId: string;
  placeholder?: string;
  autoFocus?: boolean;
  class?: string;
}

function ChatComposer({ chatId, placeholder, autoFocus, class: className }: ChatComposerProps) {
  const navigate = useNavigate();
  const store = useChatSession(chatId, { markViewing: false });
  const state = store.state.value;
  const ready = store.status.value === "ready";
  const harnessCommands = store.commands.value;
  const slashCommands = useMemo(() => mergeCommands(builtinCommands(true), harnessCommands), [harnessCommands]);

  // The agent is running once the chat is loaded; fetch its slash commands then (cached).
  useEffect(() => {
    if (ready) void loadChatCommands(chatId);
  }, [chatId, ready]);
  const models = visibleModels.value;
  const uiRequests = store.uiRequests.value;
  const agentError = store.agentError.value;
  const queued = [
    ...state.queue.steering.map((text) => ({ kind: "Steer", text })),
    ...state.queue.followUp.map((text) => ({ kind: "Follow-up", text })),
  ];

  const onSend = (text: string, images: PromptImage[]) =>
    runAction(
      () =>
        api.prompt(chatId, {
          text,
          images: images.length ? images : undefined,
          behavior: store.state.value.isRunning ? settings.value.general.busyBehavior : undefined,
        }),
      "Could not send message",
    );

  const onModelChange = (model: ModelRef) => {
    const info = modelInfo(models, model);
    const prev = store.state.value;
    store.state.value = {
      ...prev,
      model,
      ...(info ? { thinkingLevels: info.thinkingLevels, thinkingLevel: clampThinkingLevel(info.thinkingLevels, prev.thinkingLevel) } : {}),
    };
    void runAction(() => api.setModel(chatId, model), "Could not change model").then((ok) => {
      if (!ok) store.state.value = prev;
    });
  };

  const onThinkingChange = (level: ThinkingLevel) => {
    const prev = store.state.value;
    store.state.value = { ...prev, thinkingLevel: level };
    void runAction(() => api.setThinkingLevel(chatId, level), "Could not change thinking level").then((ok) => {
      if (!ok) store.state.value = prev;
    });
  };

  const above = (
    <>
      {agentError && (
        <div role="alert" class="mb-2 flex items-start gap-2 rounded-[10px] border-[0.5px] border-danger/30 bg-danger/10 px-3 py-2 text-danger">
          <TriangleAlert size={14} class="mt-[2px] shrink-0" />
          <span class="selectable min-w-0 flex-1 break-words whitespace-pre-wrap">{agentError}</span>
          <button type="button" aria-label="Dismiss" class="shrink-0 rounded-control p-0.5 hover:bg-hover" onClick={() => (store.agentError.value = null)}>
            <X size={13} />
          </button>
        </div>
      )}
      {uiRequests[0] && (
        <UiRequestCard
          request={uiRequests[0]}
          more={uiRequests.length - 1}
          onRespond={(response) => {
            store.uiRequests.value = store.uiRequests.value.filter((r) => r.id !== response.id);
            void runAction(() => api.respondToUi(chatId, response), "Could not send answer");
          }}
        />
      )}
      {state.isCompacting && (
        <div role="status" class="mb-2 flex items-center justify-center gap-2 text-[0.88rem] text-fg-muted">
          <Spinner size={12} />
          Compacting context…
        </div>
      )}
      {queued.length > 0 && (
        <div class="mb-2 flex flex-col items-end gap-1" aria-label="Queued messages">
          {queued.map((q, i) => (
            <div key={i} class="flex max-w-[85%] items-center gap-1.5 rounded-full bg-selected px-2.5 py-0.5 text-[0.88rem] text-fg-muted">
              <span class="shrink-0 text-fg-subtle">{q.kind}</span>
              <span class="truncate">{q.text}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <ComposerBox
      draftKey={`chat:${chatId}`}
      placeholder={placeholder}
      autoFocus={autoFocus && !uiRequests[0]}
      isRunning={state.isRunning}
      supportsImages={supportsImageInput(modelInfo(models, state.model))}
      model={state.model}
      models={models}
      onModelChange={onModelChange}
      thinkingLevel={state.thinkingLevel}
      thinkingLevels={state.thinkingLevels}
      onThinkingChange={onThinkingChange}
      onSend={onSend}
      onStop={() => void runAction(() => api.abort(chatId), "Could not stop")}
      above={above}
      toolbarExtra={<ContextMeter usage={state.contextUsage} cost={state.sessionStats?.cost} compacting={state.isCompacting} />}
      slash={{ commands: slashCommands, chatId, projectId: null, navigate }}
      class={className}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------------------------

export interface NewChatComposerProps {
  projectId: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  class?: string;
}

const NEW_CHAT_COMMANDS = builtinCommands(false);

function NewChatComposer({ projectId, placeholder, autoFocus, class: className }: NewChatComposerProps) {
  const navigate = useNavigate();
  const models = visibleModels.value;
  const defaults = settings.value.models;
  const [pickedModel, setPickedModel] = useState<ModelRef | null>(null);
  const [pickedLevel, setPickedLevel] = useState<ThinkingLevel | null>(null);
  const [busy, setBusy] = useState(false);

  const defaultModel = defaults.defaultModel && models.some((m) => sameModel(m, defaults.defaultModel)) ? defaults.defaultModel : null;
  const first = models[0];
  const model: ModelRef | null = pickedModel ?? defaultModel ?? (first ? { provider: first.provider, id: first.id } : null);
  const info = modelInfo(models, model);
  const levels = info?.thinkingLevels ?? ["off"];
  const thinkingLevel = clampThinkingLevel(levels, pickedLevel ?? defaults.defaultThinkingLevel);

  const onSend = async (text: string, images: PromptImage[]) => {
    setBusy(true);
    try {
      const detail = await api.createChat({
        projectId,
        prompt: text,
        images: images.length ? images : undefined,
        model,
        thinkingLevel: model ? thinkingLevel : null,
      });
      applyChatDetail(detail);
      navigate(chatPath(detail.chat));
      return true;
    } catch (err) {
      notify("error", `Could not start chat: ${(err as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <ComposerBox
      draftKey={`new:${projectId ?? ""}`}
      placeholder={placeholder}
      autoFocus={autoFocus}
      busy={busy}
      supportsImages={supportsImageInput(info)}
      model={model}
      models={models}
      onModelChange={setPickedModel}
      thinkingLevel={thinkingLevel}
      thinkingLevels={levels}
      onThinkingChange={setPickedLevel}
      onSend={onSend}
      // No agent yet, so no harness commands: only built-ins that work before the chat exists.
      slash={{ commands: NEW_CHAT_COMMANDS, chatId: null, projectId, navigate }}
      class={className}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------

export type ComposerProps = { placeholder?: string; autoFocus?: boolean; class?: string } & (
  | { chatId: string; projectId?: never }
  | { chatId?: null; projectId: string | null }
);

export function Composer(props: ComposerProps) {
  if (props.chatId) {
    return <ChatComposer chatId={props.chatId} placeholder={props.placeholder} autoFocus={props.autoFocus ?? true} class={props.class} />;
  }
  return <NewChatComposer projectId={props.projectId ?? null} placeholder={props.placeholder} autoFocus={props.autoFocus ?? true} class={props.class} />;
}
