/**
 * Message composer. Reusable anywhere:
 *
 *   <Composer chatId="…" />              existing chat (a session id): prompts, queues while running, stop
 *   <Composer projectId={id | null} />   "new" mode: creates the chat on first send and
 *                                        navigates to it (needs a router)
 *
 * Both are thin wrappers around <ComposerBox>, which owns the textarea, attachments, send
 * keys, toolbar and the slash-command menu but none of the data flow.
 *
 * Slash commands: typing `/` at the start opens a menu of Glade built-ins (slash/builtins.ts,
 * run here in the browser) plus the harness commands (sent to the agent as a prompt): the
 * chat's, or before a chat exists the folder's (I-043). Hidden ones (I-048) are left out of the
 * menu but still run when typed in full.
 *
 * File mentions (I-044): typing `@` at the start or after whitespace opens a file menu for the
 * chat's folder; picking inserts `@relative/path` (folders complete stepwise).
 *
 * Attachments (I-090): the paperclip, drag-and-drop and paste accept any file. Images go inline
 * with the prompt (downscaled; as files when the model can't take images); other files are shown
 * as chips and, on send, uploaded to the session's attachments folder and referenced by path
 * (`Attached file: …` lines, state/attachments.ts). A new chat with files is created first, then
 * prompted, since uploads belong to a session.
 *
 * Shell mode (I-076, harnesses with the `shell` capability): text starting with `!` runs as a
 * shell command in the chat's folder instead of being sent (`!cmd` shares the output with the
 * agent for its next prompt, `!!cmd` doesn't); the box gets the shell tone and a hint, and the
 * slash/`@` menus are off.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { ArrowUp, Paperclip, Square, Terminal, TriangleAlert, X } from "lucide-preact";
import {
  DEFAULT_IMAGE_LIMITS,
  MAX_ATTACHMENT_BYTES,
  activeElsewhereMessage,
  parseAttachedFiles,
  clampThinkingLevel,
  sameModel,
  type FileEntry,
  type ModelInfo,
  type ModelRef,
  type PromptImage,
  type SlashCommand,
  type ThinkingLevel,
} from "@glade/protocol";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { chatPath } from "@/app/routes";
import { loadChatCommands, runAction, useChatSession } from "@/state/chat-session";
import { createWorkspace } from "@/state/actions";
import { attachFilesToText } from "@/state/attachments";
import { harnessCapabilities, newChatHarnessInfo } from "@/state/harnesses";
import { harnessDefaults, models as allModels, sessionsById, settings, visibleModels, workspacesById } from "@/state/store";
import { isSlashCommandHidden } from "@/state/slash-visibility";
import { notify } from "@/state/toasts";
import { Chip, Spinner, Tooltip } from "@/ui";
import {
  formatBytes,
  isSendKey,
  parseShellInput,
  readImageFile,
  splitAttachableFiles,
  type Attachment,
  type PendingFile,
  type ShellInput,
} from "./composer-utils";
import { fileIcon } from "./UserBubble";
import { useImageLightbox } from "./ImageLightbox";
import { ContextMeter } from "./ContextMeter";
import { ModelPicker, ThinkingPicker } from "./Pickers";
import { InterruptedBanner } from "./InterruptedBanner";
import { UiRequestCard } from "./UiRequestCard";
import { builtinCommands, findBuiltin, type SlashContext } from "./slash/builtins";
import { filterCommands, mergeCommands, parseSlash } from "./slash/match";
import { SLASH_MENU_ID, SlashMenu, slashOptionId } from "./slash/SlashMenu";
import { useFolderCommands } from "./slash/folder-commands";
import { findSavedPrompt, savedPromptCommands, withSavedPrompts } from "./slash/saved-prompts";
import { applyMention, findMention } from "./mentions/parse";
import { MENTION_MENU_ID, MentionMenu, mentionOptionId } from "./mentions/MentionMenu";
import { useFileSearch } from "./mentions/useFileSearch";

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
  /**
   * Read-only with this explanation as the placeholder (I-062: the session runs in another
   * Glade server right now). Unlike `busy`, no spinner.
   */
  lockedReason?: string;
  supportsImages: boolean;
  model: ModelRef | null;
  models: ModelInfo[];
  onModelChange: (model: ModelRef) => void;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  onThinkingChange: (level: ThinkingLevel) => void;
  /** Hide the model and thinking pickers (harnesses that choose their own model, e.g. ACP agents; I-119). */
  hideModelPickers?: boolean;
  /** Resolve true to clear the input. `files` = attached by reference (I-090), in order. */
  onSend: (text: string, images: PromptImage[], files: File[]) => Promise<boolean>;
  onStop?: () => void;
  /** Rendered above the input box (queue chips, dialogs, banners). */
  above?: ComponentChildren;
  /** Extra toolbar items after the pickers (e.g. the context meter). */
  toolbarExtra?: ComponentChildren;
  slash?: ComposerSlashOptions;
  /** Enables `@` file mentions for the folder of this project (`null` = scratch folder). */
  mentions?: { projectId: string | null };
  /** Enables shell mode (`!cmd` / `!!cmd`, I-076). `run` resolves true when the command started. */
  shell?: { run: (input: ShellInput) => Promise<boolean> };
  class?: string;
}

export function ComposerBox(props: ComposerBoxProps) {
  const { draftKey, isRunning = false, busy: loading = false, supportsImages, lockedReason } = props;
  /** No typing or sending: loading, or locked (read-only). */
  const busy = loading || !!lockedReason;
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [images, setImages] = useState<Attachment[]>([]);
  const { open: openImage, lightbox: imageLightbox } = useImageLightbox(images);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openPicker, setOpenPicker] = useState<"model" | "thinking" | null>(null);
  const pickerFromSlash = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendKey = settings.value.general.sendKey;
  const slash = props.slash;

  // Shell mode (I-076): `!cmd` / `!!cmd` runs a command instead of sending a message.
  const shellInput = props.shell ? parseShellInput(text) : null;
  const shellHintId = `shell-hint-${draftKey}`;

  // Slash menu: open while typing a command name at the very start of the text.
  const parsed = slash && !shellInput ? parseSlash(text) : null;
  const typingName = parsed && !parsed.hasArgs ? parsed.name : null;
  const slashSettings = settings.value;
  const menuCommands = useMemo(
    () =>
      slash
        ? withSavedPrompts(slash.commands, savedPromptCommands(slashSettings.prompts, slash.projectId)).filter((c) => !isSlashCommandHidden(slashSettings, c))
        : [],
    [slash?.commands, slash?.projectId, slashSettings.slashCommands, slashSettings.prompts],
  );
  const groups = useMemo(() => (slash && typingName !== null ? filterCommands(menuCommands, typingName) : []), [menuCommands, typingName]);
  const flat = groups.flatMap((g) => g.commands);
  const menuOpen = typingName !== null && !menuDismissed && !busy && flat.length > 0;
  const active = Math.min(activeIndex, Math.max(0, flat.length - 1));

  // `@` file mentions: the token at the caret; the menu lists matching files of the folder.
  const [caret, setCaret] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mention = props.mentions && !menuOpen && !busy && !shellInput ? findMention(text, Math.min(caret, text.length)) : null;
  const mentionWanted = mention !== null && mention.start !== mentionDismissedAt;
  const fileEntries = useFileSearch(props.mentions?.projectId ?? null, mentionWanted ? mention.query : null);
  const mentionOpen = mentionWanted && fileEntries.length > 0;
  const mentionActive = Math.min(mentionIndex, Math.max(0, fileEntries.length - 1));
  useEffect(() => setMentionIndex(0), [mention?.start, mention?.query]);
  useEffect(() => {
    if (mention === null) setMentionDismissedAt(null);
  }, [mention === null]);
  const syncCaret = (e: Event) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart ?? 0);

  useEffect(() => setActiveIndex(0), [typingName]);
  useEffect(() => {
    if (typingName === null) setMenuDismissed(false);
  }, [typingName === null]);

  // Switch drafts when the composer is reused for another chat.
  useEffect(() => {
    setText(drafts.get(draftKey) ?? "");
    setImages([]);
    setFiles([]);
  }, [draftKey]);

  useEffect(() => {
    if (props.autoFocus !== false) textareaRef.current?.focus();
  }, [draftKey]);

  // Auto-grow up to 40% of the viewport.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      // Put the caret after an inserted mention.
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
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

  /** Attach dropped/picked/pasted files: images inline, everything else by reference (I-090). */
  const addFiles = async (list: FileList | File[] | null | undefined) => {
    const { images: imageList, files: others, tooLarge } = splitAttachableFiles(list, supportsImages, MAX_ATTACHMENT_BYTES);
    for (const file of tooLarge) notify("error", `${file.name} is too large to attach (${formatBytes(file.size)}; the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}).`);
    if (others.length) setFiles((prev) => [...prev, ...others]);
    if (imageList.length === 0) return;
    try {
      const limits = modelInfo(props.models, props.model)?.imageLimits ?? DEFAULT_IMAGE_LIMITS;
      const read = await Promise.all(imageList.map((file) => readImageFile(file, limits)));
      setImages((prev) => [...prev, ...read]);
    } catch (err) {
      notify("error", `Could not attach image: ${(err as Error).message}`);
    }
  };

  const canSend = !busy && (shellInput ? shellInput.command.length > 0 : text.trim().length > 0 || images.length > 0 || files.length > 0);

  /** Replace the text with a saved prompt's (I-098; never sent here), caret at the end. */
  const insertPrompt = (body: string) => {
    updateText(body);
    pendingCaret.current = body.length;
    textareaRef.current?.focus();
  };

  /** The saved prompt `/name` stands for, unless a command of this composer has that name. */
  const savedPromptFor = (name: string) =>
    slash && !slash.commands.some((c) => c.name === name) ? findSavedPrompt(settings.value.prompts, slash.projectId, name) : null;

  /** Insert `/name ` and keep typing arguments (a saved prompt inserts its text). */
  const complete = (command: SlashCommand) => {
    const saved = command.source === "saved" ? savedPromptFor(command.name) : null;
    if (saved) return insertPrompt(saved.body);
    updateText(`/${command.name} `);
    setMenuDismissed(false);
    textareaRef.current?.focus();
  };

  /** Insert the picked file/folder for the `@` token at the caret. */
  const pickMention = (entry: FileEntry) => {
    if (!mention) return;
    const next = applyMention(text, mention, entry);
    updateText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
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
    if (shellInput && props.shell) {
      // Runs in the chat's folder instead of being sent (attached images stay for the next message).
      const typed = text;
      updateText("");
      if (!(await props.shell.run(shellInput))) updateText(typed);
      return;
    }
    const sentText = text.trim();
    const sentImages = images;
    const sentFiles = files;
    const typedSlash = slash ? parseSlash(sentText) : null;
    const saved = typedSlash ? savedPromptFor(typedSlash.name) : null;
    if (typedSlash && saved) {
      // `/saved-prompt [more text]` typed in full: insert the prompt instead of sending (I-098).
      insertPrompt(typedSlash.args ? `${saved.body}\n\n${typedSlash.args}` : saved.body);
      return;
    }
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
    setFiles([]);
    const ok = await props.onSend(
      sentText,
      sentImages.map(({ mimeType, data }) => ({ mimeType, data })),
      sentFiles.map((f) => f.file),
    );
    if (!ok) {
      updateText(sentText);
      setImages(sentImages);
      setFiles(sentFiles);
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
    if (mentionOpen && mention && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((mentionActive + step + fileEntries.length) % fileEntries.length);
        return;
      }
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        pickMention(fileEntries[mentionActive]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissedAt(mention.start);
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
          "relative flex flex-col rounded-[14px] bg-surface-raised transition-shadow",
          dragging
            ? "shadow-[0_0_0_2px_var(--pi-accent)]"
            : shellInput
              ? "shadow-[0_0_0_1.5px_var(--pi-tool-shell),0_2px_10px_-4px_rgb(0_0_0/0.12)]"
              : "shadow-[0_0_0_0.5px_var(--pi-separator),0_2px_10px_-4px_rgb(0_0_0/0.12)] focus-within:shadow-[0_0_0_0.5px_var(--pi-fg-subtle),0_2px_12px_-4px_rgb(0_0_0/0.16)]",
        )}
        data-shell-mode={shellInput ? (shellInput.shareWithAgent ? "shared" : "private") : undefined}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          const dropped = Array.from(e.dataTransfer?.files ?? []);
          if (dropped.length) {
            e.preventDefault();
            if (!busy) void addFiles(dropped);
          }
        }}
      >
        {menuOpen && <SlashMenu groups={groups} activeIndex={active} onHover={setActiveIndex} onPick={complete} />}
        {mentionOpen && <MentionMenu entries={fileEntries} activeIndex={mentionActive} onHover={setMentionIndex} onPick={pickMention} />}
        {(images.length > 0 || files.length > 0) && (
          <div class="flex flex-wrap items-center gap-2 px-3 pt-3" aria-label="Attachments">
            {images.map((img, i) => (
              <div key={img.id} class="group/att relative">
                {/* Opens large like transcript images (I-115); the × below is a sibling, so it doesn't. */}
                <button
                  type="button"
                  aria-label={`Open ${img.name}`}
                  onClick={() => openImage(i)}
                  class="flex cursor-zoom-in rounded-[8px] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={img.name}
                    class="size-14 rounded-[8px] border-[0.5px] border-separator object-cover"
                  />
                </button>
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
            {files.map((f) => {
              const Icon = fileIcon(f.name);
              return (
                <Chip
                  key={f.id}
                  icon={<Icon />}
                  label={f.name}
                  title={`${f.name} · ${formatBytes(f.file.size)}`}
                  onRemove={() => setFiles((prev) => prev.filter((p) => p.id !== f.id))}
                />
              );
            })}
            {imageLightbox}
          </div>
        )}
        {shellInput && (
          <div id={shellHintId} data-tone="shell" class="flex items-center gap-1.5 px-3.5 pt-2 -mb-1.5 text-[0.85rem] select-none">
            <Terminal size={12} strokeWidth={2.25} class="pi-tone-text" aria-hidden="true" />
            <span class="pi-tone-text font-medium">Shell</span>
            <span class="text-fg-muted">{shellInput.shareWithAgent ? "Run a command — shared with the agent" : "Run a command — not shared with the agent"}</span>
            {shellInput.shareWithAgent && <span class="text-fg-subtle">· start with !! to keep it private</span>}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={busy}
          placeholder={lockedReason ?? props.placeholder ?? (isRunning ? "Queue a message…" : "Ask anything…")}
          aria-label="Message"
          aria-autocomplete={slash || props.mentions ? "list" : undefined}
          aria-expanded={slash || props.mentions ? menuOpen || mentionOpen : undefined}
          aria-controls={menuOpen ? SLASH_MENU_ID : mentionOpen ? MENTION_MENU_ID : undefined}
          aria-activedescendant={menuOpen ? slashOptionId(active) : mentionOpen ? mentionOptionId(mentionActive) : undefined}
          aria-describedby={shellInput ? shellHintId : undefined}
          class={cn(
            "selectable block max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[1rem] leading-[1.5] text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none disabled:opacity-60",
            shellInput && "font-mono text-[0.95rem]",
          )}
          onInput={(e) => {
            updateText(e.currentTarget.value);
            syncCaret(e);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData?.files ?? []);
            if (pasted.length) {
              e.preventDefault();
              void addFiles(pasted);
            }
          }}
        />
        <div class="flex items-center gap-1 px-2 pt-1 pb-2">
          <Tooltip content="Attach files">
            <button
              type="button"
              aria-label="Attach files"
              disabled={busy}
              class="inline-flex size-6 items-center justify-center rounded-control text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip size={14} />
            </button>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              void addFiles(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = "";
            }}
          />
          {!props.hideModelPickers && (
            <>
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
            </>
          )}
          {props.toolbarExtra}
          <div class="flex-1" />
          {loading && <Spinner size={14} class="mr-1" />}
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
              aria-label={shellInput ? "Run command" : isRunning ? "Queue message" : "Send"}
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

/** A queued message's text without its `Attached file:` lines (I-090), plus a file count. */
function QueuedText({ text }: { text: string }) {
  const parsed = parseAttachedFiles(text);
  return (
    <>
      <span class="truncate">{parsed.text}</span>
      {parsed.files.length > 0 && (
        <span class="flex shrink-0 items-center gap-0.5 text-fg-subtle">
          <Paperclip size={11} />
          {parsed.files.length}
        </span>
      )}
    </>
  );
}

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
  const summary = sessionsById.value.get(chatId);
  // I-065: hide what this chat's harness can't do (all allowed until the harness list loads).
  const capabilities = harnessCapabilities(summary?.harness);
  const slashCommands = useMemo(
    () => mergeCommands(builtinCommands(true, capabilities), harnessCommands),
    [harnessCommands, capabilities],
  );

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

  const onSend = (text: string, images: PromptImage[], files: File[]) =>
    runAction(
      async () =>
        api.prompt(chatId, {
          text: await attachFilesToText(chatId, text, files),
          images: images.length ? images : undefined,
          // Steer vs follow-up only exists for harnesses with message queues (I-065).
          behavior: store.state.value.isRunning && capabilities.steering ? settings.value.general.busyBehavior : undefined,
        }),
      "Could not send message",
    );

  const runShell = ({ command, shareWithAgent }: ShellInput) =>
    runAction(() => api.runShell(chatId, { command, shareWithAgent }), "Could not run the command");

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

  const interrupted = summary?.interrupted === true;
  // I-062: another Glade server (e.g. the dev server next to the installed app) runs it right now.
  const lockedReason = summary?.activeElsewhere ? activeElsewhereMessage(summary.activeElsewhere) : undefined;
  const projectId = (summary && workspacesById.value.get(summary.workspaceId)?.projectId) ?? null;

  const above = (
    <>
      {interrupted && !state.isRunning && !lockedReason && <InterruptedBanner chatId={chatId} />}
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
              <QueuedText text={q.text} />
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
      isRunning={state.isRunning && !lockedReason}
      lockedReason={lockedReason}
      supportsImages={supportsImageInput(modelInfo(models, state.model))}
      model={state.model}
      models={models}
      onModelChange={onModelChange}
      thinkingLevel={state.thinkingLevel}
      thinkingLevels={state.thinkingLevels}
      onThinkingChange={onThinkingChange}
      hideModelPickers={capabilities.models === false}
      onSend={onSend}
      onStop={() => void runAction(() => api.abort(chatId), "Could not stop")}
      above={above}
      toolbarExtra={<ContextMeter usage={state.contextUsage} cost={state.sessionStats?.cost} compacting={state.isCompacting} model={state.model} />}
      slash={{ commands: slashCommands, chatId, projectId, navigate }}
      mentions={{ projectId }}
      shell={capabilities.shell ? { run: runShell } : undefined}
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
/** Every built-in name: harness commands with these names stay hidden in new chats too. */
const BUILTIN_NAMES = new Set(builtinCommands(true).map((c) => c.name));

function NewChatComposer({ projectId, placeholder, autoFocus, class: className }: NewChatComposerProps) {
  const navigate = useNavigate();
  const models = visibleModels.value;
  const defaults = settings.value.models;
  const [pickedModel, setPickedModel] = useState<ModelRef | null>(null);
  const [pickedLevel, setPickedLevel] = useState<ThinkingLevel | null>(null);
  const [busy, setBusy] = useState(false);

  // The agent picked in the context bar (I-119); ACP agents choose their own model.
  const target = newChatHarnessInfo.value;
  const otherHarness = target && !target.isDefault ? target.id : undefined;
  const usesModels = target?.capabilities.models !== false;

  // No agent yet: built-ins that work without a chat + the folder's harness commands (I-043).
  // Those are the default harness's; another agent's commands are only known once its chat runs.
  const folderCommands = useFolderCommands(projectId);
  const slashCommands = useMemo(
    () => mergeCommands(NEW_CHAT_COMMANDS, otherHarness ? [] : (folderCommands ?? []).filter((c) => !BUILTIN_NAMES.has(c.name))),
    [folderCommands, otherHarness],
  );

  // Glade's default model, else ("Default") the harness's own default (I-050), else the first.
  const defaultModel = defaults.defaultModel && models.some((m) => sameModel(m, defaults.defaultModel)) ? defaults.defaultModel : null;
  const harness = harnessDefaults.value;
  const harnessModel = !defaultModel && harness?.model ? harness.model : null;
  const first = models[0];
  const model: ModelRef | null = pickedModel ?? defaultModel ?? harnessModel ?? (first ? { provider: first.provider, id: first.id } : null);
  // The harness's default may be hidden from the picker; still describe it correctly.
  const info = modelInfo(models, model) ?? modelInfo(allModels.value, model);
  const levels = info?.thinkingLevels ?? ["off"];
  const followsHarness = !pickedModel && harnessModel !== null;
  const defaultLevel = followsHarness ? (harness?.thinkingLevel ?? defaults.defaultThinkingLevel) : defaults.defaultThinkingLevel;
  const thinkingLevel = clampThinkingLevel(levels, pickedLevel ?? defaultLevel);

  const onSend = async (text: string, images: PromptImage[], files: File[]) => {
    setBusy(true);
    try {
      const withFiles = files.length > 0;
      const created = await createWorkspace({
        projectId,
        // Files are uploaded into the new session's folder, so it's created first, then prompted.
        prompt: withFiles ? undefined : text,
        images: !withFiles && images.length ? images : undefined,
        // Following the harness default: send no model, so the harness decides (its settings apply).
        model: followsHarness || !usesModels ? null : model,
        thinkingLevel: model && usesModels ? thinkingLevel : null,
        ...(otherHarness ? { harness: otherHarness } : {}),
      });
      if (withFiles) {
        const sessionId = created.session.session.id;
        const sent = await runAction(
          async () => api.prompt(sessionId, { text: await attachFilesToText(sessionId, text, files), images: images.length ? images : undefined }),
          "Could not send message",
        );
        // The chat exists either way; keep the text in its composer when sending failed.
        if (!sent && text) drafts.set(`chat:${sessionId}`, text);
      }
      navigate(chatPath(created.workspace));
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
      supportsImages={usesModels ? supportsImageInput(info) : true}
      model={model}
      models={models}
      onModelChange={setPickedModel}
      thinkingLevel={thinkingLevel}
      thinkingLevels={levels}
      onThinkingChange={setPickedLevel}
      hideModelPickers={!usesModels}
      onSend={onSend}
      slash={{ commands: slashCommands, chatId: null, projectId, navigate }}
      mentions={{ projectId }}
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
