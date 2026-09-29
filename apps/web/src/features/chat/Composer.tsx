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
 *
 * Ask Aside (I-140, harnesses with the `sideQuestions` capability): while the agent is running and
 * there's text, a button next to Stop/Send (and ⌥↩) asks the text as a side question instead of
 * queueing it: answered now in a card, never seen by the agent. Its slot is always reserved so
 * nothing shifts when the chat goes idle; otherwise it's invisible. `/btw <question>` works anytime.
 *
 * Send keys (I-153, fixed, no settings): ↩ sends (steers while running), ⌘↩ sends a follow-up
 * (after the agent finishes), ⌥↩ asks aside, ⇧↩ inserts a new line. While running, holding ⌘
 * turns the send button into its follow-up form (icon, tooltip, label; same size and slot), and
 * clicking it then sends a follow-up. Harnesses without steering queue either way.
 *
 * Touch (the iPhone app, I-164; `touch` prop, default `isIphoneApp()`): ↩ inserts a new line and
 * only the Send button sends (steers while running). Holding Send opens its options as a sheet
 * (`OptionSheetContext`): Steer, Send as Follow-up, Ask Aside. Bigger buttons; no separate Ask
 * Aside button.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { ArrowUp, ClockArrowUp, MessageCircleQuestionMark, Paperclip, Plus, Square, Terminal, TriangleAlert, X } from "lucide-preact";
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
import { isIphoneApp } from "@/lib/desktop";
import { apiForSession } from "@/state/env-api";
import { chatPath } from "@/app/routes";
import { loadChatCommands, runAction, useChatSession } from "@/state/chat-session";
import { createWorkspace } from "@/state/actions";
import { attachFilesToText } from "@/state/attachments";
import { harnessCapabilities, newChatHarnessFor } from "@/state/harnesses";
import { envIdOfProject, envIdOfSession, sessionsById, shellOf, visibleModelsOf, workspacesById } from "@/state/store";
import { isLocalEnvironment } from "@/state/env-registry";
import { isSlashCommandHidden } from "@/state/slash-visibility";
import { notify } from "@/state/toasts";
import { Chip, Spinner, Tooltip } from "@/ui";
import {
  enterAction,
  formatBytes,
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
import { ModelPicker, ModelThinkingPicker, ThinkingPicker } from "./Pickers";
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
import { composerPrefill, withPrefill } from "./composer-prefill";
import { askSideQuestion } from "./side-question-actions";
import { useMetaHeld } from "./use-meta-held";
import { useOptionSheet, type OptionSheetItem } from "./option-sheet";

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
  /**
   * Resolve true to clear the input. `files` = attached by reference (I-090), in order. `behavior`
   * = what the user asked for while running (↩ steer, ⌘↩ follow-up, I-153); ignored when idle.
   */
  onSend: (text: string, images: PromptImage[], files: File[], behavior: SendBehavior) => Promise<boolean>;
  onStop?: () => void;
  /** Rendered above the input box (queue chips, dialogs, banners). */
  above?: ComponentChildren;
  /** Extra toolbar items after the pickers (e.g. the context meter). */
  toolbarExtra?: ComponentChildren;
  slash?: ComposerSlashOptions;
  /** Enables `@` file mentions for the folder of this project (`null` = scratch folder of `envId`). */
  mentions?: { projectId: string | null; envId?: string | null };
  /** The environment the chat runs on (I-123): its saved prompts and hidden commands apply. */
  envId?: string | null;
  /** Enables shell mode (`!cmd` / `!!cmd`, I-076). `run` resolves true when the command started. */
  shell?: { run: (input: ShellInput) => Promise<boolean> };
  /**
   * Enables Ask Aside (I-140): ask the text as a side question while the agent runs. Resolves true
   * when it was asked.
   */
  askAside?: (question: string) => Promise<boolean>;
  /**
   * The harness can steer a running agent (I-065). Without it, ↩ and ⌘↩ both queue a message and
   * there's no steer/follow-up choice. Default true.
   */
  steering?: boolean;
  /**
   * Touch composer (I-164): ↩ is a new line, the Send button sends, holding it offers steer /
   * follow-up / Ask Aside. Default: `isIphoneApp()`.
   */
  touch?: boolean;
  class?: string;
}

/** How long Send must be held on touch to open its options (ms). */
export const SEND_LONG_PRESS_MS = 450;

export type SendBehavior = "steer" | "followUp";

export function ComposerBox(props: ComposerBoxProps) {
  const { draftKey, isRunning = false, busy: loading = false, supportsImages, lockedReason } = props;
  /** No typing or sending: loading, or locked (read-only). */
  const busy = loading || !!lockedReason;
  const touch = props.touch ?? isIphoneApp();
  const OptionSheet = useOptionSheet();
  const [sendOptionsOpen, setSendOptionsOpen] = useState(false);
  /** Touch: the text field has the focus (the box grows while it does; see `expanded`). */
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
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
  const slash = props.slash;

  // Shell mode (I-076): `!cmd` / `!!cmd` runs a command instead of sending a message.
  const shellInput = props.shell ? parseShellInput(text) : null;
  const shellHintId = `shell-hint-${draftKey}`;

  // Slash menu: open while typing a command name at the very start of the text.
  const parsed = slash && !shellInput ? parseSlash(text) : null;
  const typingName = parsed && !parsed.hasArgs ? parsed.name : null;
  const slashSettings = shellOf(props.envId).settings.value;
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
  const fileEntries = useFileSearch(props.mentions?.projectId ?? null, mentionWanted ? mention.query : null, props.mentions?.envId);
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

  // "Tell the Agent" on a side question card (I-140): add its text to this draft and focus.
  const prefill = composerPrefill.value;
  useEffect(() => {
    if (!prefill || prefill.draftKey !== draftKey) return;
    composerPrefill.value = null;
    const next = withPrefill(drafts.get(draftKey) ?? "", prefill.text);
    updateText(next);
    pendingCaret.current = next.length;
    textareaRef.current?.focus();
  }, [prefill, draftKey]);

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
  // Ask Aside (I-140): only while the agent works and there's a question typed.
  const canAskAside = !!props.askAside && isRunning && !busy && !shellInput && text.trim().length > 0;
  // Steer vs follow-up (I-153): only while running, for harnesses that steer, and not in shell mode.
  const steering = props.steering !== false;
  const choosesBehavior = isRunning && steering && !busy && !shellInput;
  const followUpHeld = useMetaHeld(choosesBehavior);

  /** Ask the typed text as a side question (a typed `/btw ` prefix is dropped); attachments stay. */
  const askAside = async () => {
    if (!canAskAside || !props.askAside) return;
    const typed = text;
    const cmd = parseSlash(typed.trim());
    const question = cmd?.name === "btw" ? cmd.args : typed.trim();
    if (!question.trim()) return;
    updateText("");
    if (!(await props.askAside(question))) updateText(typed);
  };

  /** Replace the text with a saved prompt's (I-098; never sent here), caret at the end. */
  const insertPrompt = (body: string) => {
    updateText(body);
    pendingCaret.current = body.length;
    textareaRef.current?.focus();
  };

  /** The saved prompt `/name` stands for, unless a command of this composer has that name. */
  const savedPromptFor = (name: string) =>
    slash && !slash.commands.some((c) => c.name === name) ? findSavedPrompt(slashSettings.prompts, slash.projectId, name) : null;

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

  const send = async (behavior: SendBehavior = "steer") => {
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
      behavior,
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
        if (command.name === typingName) void send(e.metaKey || e.ctrlKey ? "followUp" : "steer");
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
    // Touch (I-164): ↩ is a plain new line; only the Send button sends.
    const action = touch ? null : enterAction(e);
    if (action === "askAside" && canAskAside) {
      e.preventDefault();
      void askAside();
      return;
    }
    if (action === "send" || action === "followUp") {
      e.preventDefault();
      void send(action === "followUp" ? "followUp" : "steer");
      return;
    }
    if (e.key === "Escape" && isRunning && props.onStop) {
      e.preventDefault();
      props.onStop();
    }
  };

  // Touch (I-164): holding Send offers steer / follow-up / Ask Aside.
  const hasSendOptions = touch && !!OptionSheet && (choosesBehavior || canAskAside);
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const sendPressHandlers = touch
    ? {
        onTouchStart: () => {
          longPressed.current = false;
          cancelLongPress();
          if (!hasSendOptions) return;
          longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            longPressed.current = true;
            setSendOptionsOpen(true);
          }, SEND_LONG_PRESS_MS);
        },
        onTouchEnd: cancelLongPress,
        onTouchMove: cancelLongPress,
        onTouchCancel: cancelLongPress,
        onContextMenu: (e: Event) => e.preventDefault(),
        // Keep the keyboard up: tapping Send mustn't take the focus from the text.
        onMouseDown: (e: Event) => e.preventDefault(),
      }
    : {};
  useEffect(() => cancelLongPress, []);
  const sendOptions: OptionSheetItem[] = [];
  if (choosesBehavior) {
    sendOptions.push(
      { key: "steer", label: "Steer", description: "Delivered after the agent's current step", disabled: !canSend, onSelect: () => void send("steer") },
      { key: "followUp", label: "Send as Follow-up", description: "Sent after the agent finishes", disabled: !canSend, onSelect: () => void send("followUp") },
    );
  }
  if (props.askAside) {
    sendOptions.push({ key: "askAside", label: "Ask Aside", description: "Answered now; the agent won't see it", disabled: !canAskAside, onSelect: () => void askAside() });
  }

  const sendButton = shellInput
    ? { label: "Run command", tooltip: "Run command (↩)" }
    : !isRunning
      ? { label: "Send", tooltip: "Send (↩)" }
      : !steering
        ? { label: "Queue message", tooltip: "Queue message (↩): sent after the agent finishes" }
        : followUpHeld
          ? { label: "Send follow-up", tooltip: "Follow-up (⌘↩): sent after the agent finishes" }
          : { label: "Steer", tooltip: "Steer (↩): delivered after the current step · hold ⌘ for a follow-up" };

  // Touch (I-164, like ChatGPT): a slim one-line pill ([+] text [send]) until you type into it;
  // then it grows full width with the text on top and the pickers in a row below. Same DOM in
  // both (CSS order/wrap only), so the textarea never remounts and keeps its focus.
  const expanded =
    !touch || focused || text.trim() !== "" || images.length > 0 || files.length > 0 || openPicker !== null || sendOptionsOpen || !!shellInput;
  const compact = touch && !expanded;
  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  return (
    <div class={cn("w-full", props.class)}>
      {props.above}
      <div
        data-compact={touch ? String(compact) : undefined}
        class={cn(
          "relative flex rounded-[14px] bg-surface-raised transition-shadow",
          !touch && "flex-col",
          touch && "flex-wrap items-end rounded-[22px] transition-[margin,border-radius] duration-200 ease-out",
          compact && "mx-5",
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
          <div class={cn("flex flex-wrap items-center gap-2 px-3 pt-3", touch && "order-first w-full")} aria-label="Attachments">
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
                  class={cn(
                    "absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-fg text-window opacity-0 shadow group-hover/att:opacity-100 focus-visible:opacity-100",
                    // No hover on touch: always shown, with a bigger target.
                    touch && "size-6 opacity-100",
                  )}
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
          <div id={shellHintId} data-tone="shell" class={cn("flex items-center gap-1.5 px-3.5 pt-2 -mb-1.5 text-[0.85rem] select-none", touch && "order-first w-full")}>
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
          placeholder={
            lockedReason ??
            props.placeholder ??
            (isRunning ? (touch ? touchRunningPlaceholder(steering, !!props.askAside) : runningPlaceholder(steering, !!props.askAside)) : "Ask anything…")
          }
          aria-label="Message"
          aria-autocomplete={slash || props.mentions ? "list" : undefined}
          aria-expanded={slash || props.mentions ? menuOpen || mentionOpen : undefined}
          aria-controls={menuOpen ? SLASH_MENU_ID : mentionOpen ? MENTION_MENU_ID : undefined}
          aria-activedescendant={menuOpen ? slashOptionId(active) : mentionOpen ? mentionOptionId(mentionActive) : undefined}
          aria-describedby={shellInput ? shellHintId : undefined}
          class={cn(
            "selectable block max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[1rem] leading-[1.5] text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none disabled:opacity-60",
            shellInput && "font-mono text-[0.95rem]",
            // Touch: beside [+] and Send while compact, full width above the toolbar when not.
            touch && (compact ? "order-2 w-auto min-w-0 flex-1 px-1.5 pt-[9px] pb-[9px]" : "order-1 basis-full"),
          )}
          onFocus={
            touch
              ? () => {
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  blurTimer.current = null;
                  setFocused(true);
                }
              : undefined
          }
          onBlur={
            touch
              ? () => {
                  // Late, so a tap on a picker or Send lands before the box shrinks under it.
                  blurTimer.current = setTimeout(() => {
                    blurTimer.current = null;
                    setFocused(false);
                  }, 200);
                }
              : undefined
          }
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
        {/* Touch: `contents` lets its children join the box's own row (compact) or wrap below the text. */}
        <div class={cn("flex items-center gap-1 px-2 pt-1 pb-2", touch && "contents")}>
          <Tooltip content="Attach files">
            <button
              type="button"
              aria-label="Attach files"
              disabled={busy}
              class={cn(
                "inline-flex items-center justify-center rounded-control text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40",
                touch ? "order-1 m-1 size-9 shrink-0 rounded-full" : "size-6",
                touch && !compact && "order-2",
              )}
              onClick={() => fileRef.current?.click()}
            >
              {touch ? <Plus size={22} /> : <Paperclip size={14} />}
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
            <span class={cn("contents", touch && "[&>*]:order-2", compact && "[&>*]:hidden")}>
              {touch && OptionSheet ? (
                // One pill + one sheet for both on the phone (I-164).
                <ModelThinkingPicker
                  model={props.model}
                  models={props.models}
                  onModelChange={props.onModelChange}
                  thinkingLevel={props.thinkingLevel}
                  thinkingLevels={props.thinkingLevels}
                  onThinkingChange={props.onThinkingChange}
                  disabled={busy}
                  open={openPicker !== null}
                  onOpenChange={(o) => setOpenPicker(o ? (openPicker ?? "model") : null)}
                />
              ) : (
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
            </span>
          )}
          {touch ? <span class={cn("order-2 flex items-center self-center", compact && "hidden")}>{props.toolbarExtra}</span> : props.toolbarExtra}
          <div class={cn("flex-1", touch && (compact ? "hidden" : "order-2"))} />
          {loading && <Spinner size={14} class={cn("mr-1", touch && "order-3 m-2.5 self-center")} />}
          {props.askAside && !touch && (
            // The slot is always there (no layout shift, I-140); the button only shows while it applies.
            <span class={cn("flex", !canAskAside && "invisible")} data-testid="ask-aside-slot">
              <Tooltip content="Ask aside (⌥↩): answered now, the agent won't see it">
                <button
                  type="button"
                  aria-label="Ask aside"
                  aria-hidden={canAskAside ? undefined : true}
                  tabIndex={canAskAside ? undefined : -1}
                  disabled={!canAskAside}
                  onClick={() => void askAside()}
                  data-agent-color="violet"
                  class="flex size-7 items-center justify-center rounded-full bg-agent text-window hover:opacity-85"
                >
                  <MessageCircleQuestionMark size={15} strokeWidth={2.5} />
                </button>
              </Tooltip>
            </span>
          )}
          {isRunning && props.onStop && (
            <Tooltip content="Stop (Esc)">
              <button
                type="button"
                aria-label="Stop"
                onClick={props.onStop}
                class={cn("flex items-center justify-center rounded-full bg-fg text-window hover:opacity-85", touch ? "order-3 m-1 size-9 shrink-0" : "size-7")}
              >
                <Square size={touch ? 12 : 10} fill="currentColor" strokeWidth={0} />
              </button>
            </Tooltip>
          )}
          {/* Always there (I-151): disabled without text, so buttons don't pop in and out. */}
          <Tooltip content={sendButton.tooltip}>
            <button
              type="button"
              aria-label={sendButton.label}
              data-send-behavior={choosesBehavior ? (followUpHeld ? "followUp" : "steer") : undefined}
              aria-haspopup={hasSendOptions ? "dialog" : undefined}
              disabled={!canSend}
              onClick={(e) => {
                if (longPressed.current) {
                  // The long press opened the options; this is its trailing click.
                  longPressed.current = false;
                  return;
                }
                void send(choosesBehavior && (followUpHeld || e.metaKey || e.ctrlKey) ? "followUp" : "steer");
              }}
              {...sendPressHandlers}
              class={cn(
                "flex items-center justify-center rounded-full bg-accent text-accent-fg select-none hover:brightness-110 disabled:bg-fg-subtle/40 disabled:text-window",
                touch ? "order-3 m-1 size-9 shrink-0 touch-manipulation" : "size-7",
              )}
            >
              {choosesBehavior && followUpHeld ? (
                <ClockArrowUp size={16} strokeWidth={2.25} />
              ) : (
                <ArrowUp size={touch ? 20 : 16} strokeWidth={2.5} />
              )}
            </button>
          </Tooltip>
          {OptionSheet && touch && (
            <OptionSheet
              open={sendOptionsOpen}
              onClose={() => setSendOptionsOpen(false)}
              title="Send"
              sections={[
                {
                  items: sendOptions.map((o) => ({
                    ...o,
                    onSelect: () => {
                      setSendOptionsOpen(false);
                      o.onSelect();
                    },
                  })),
                },
              ]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The placeholder while the agent works (I-153): the keys that apply, short. */
export function runningPlaceholder(steering: boolean, askAside: boolean): string {
  if (!steering) return askAside ? "Queue a message, or ⌥↩ to ask aside" : "Queue a message…";
  return askAside ? "↩ steer · ⌘↩ follow-up · ⌥↩ ask aside" : "↩ steer · ⌘↩ follow-up";
}

/** The touch placeholder while the agent works (I-164): Send steers; hold it for more. */
export function touchRunningPlaceholder(steering: boolean, askAside: boolean): string {
  if (!steering) return askAside ? "Queue a message · hold Send to ask aside" : "Queue a message…";
  return askAside ? "Steer · hold Send for follow-up or aside" : "Steer · hold Send for a follow-up";
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
  // I-123: the chat's environment decides its harnesses and models.
  const envId = envIdOfSession(chatId);
  const shell = shellOf(envId);
  // I-065: hide what this chat's harness can't do (all allowed until the harness list loads).
  const capabilities = harnessCapabilities(summary?.harness, envId);
  const slashCommands = useMemo(
    () => mergeCommands(builtinCommands(true, capabilities), harnessCommands),
    [harnessCommands, capabilities],
  );

  // The agent is running once the chat is loaded; fetch its slash commands then (cached).
  useEffect(() => {
    if (ready) void loadChatCommands(chatId);
  }, [chatId, ready]);
  const models = visibleModelsOf(shell);
  const uiRequests = store.uiRequests.value;
  const agentError = store.agentError.value;
  const queued = [
    ...state.queue.steering.map((text) => ({ kind: "Steer", text })),
    ...state.queue.followUp.map((text) => ({ kind: "Follow-up", text })),
  ];

  const onSend = (text: string, images: PromptImage[], files: File[], behavior: SendBehavior) =>
    runAction(
      async () =>
        apiForSession(chatId).prompt(chatId, {
          text: await attachFilesToText(chatId, text, files),
          images: images.length ? images : undefined,
          // Steer vs follow-up only exists for harnesses with message queues (I-065).
          behavior: store.state.value.isRunning && capabilities.steering ? behavior : undefined,
        }),
      "Could not send message",
    );

  const runShell = ({ command, shareWithAgent }: ShellInput) =>
    runAction(() => apiForSession(chatId).runShell(chatId, { command, shareWithAgent }), "Could not run the command");

  const onModelChange = (model: ModelRef) => {
    const info = modelInfo(models, model);
    const prev = store.state.value;
    store.state.value = {
      ...prev,
      model,
      ...(info ? { thinkingLevels: info.thinkingLevels, thinkingLevel: clampThinkingLevel(info.thinkingLevels, prev.thinkingLevel) } : {}),
    };
    void runAction(() => apiForSession(chatId).setModel(chatId, model), "Could not change model").then((ok) => {
      if (!ok) store.state.value = prev;
    });
  };

  const onThinkingChange = (level: ThinkingLevel) => {
    const prev = store.state.value;
    store.state.value = { ...prev, thinkingLevel: level };
    void runAction(() => apiForSession(chatId).setThinkingLevel(chatId, level), "Could not change thinking level").then((ok) => {
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
            void runAction(() => apiForSession(chatId).respondToUi(chatId, response), "Could not send answer");
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
          {/* Stopping a run keeps the queue (pi and ACP alike): say when it will be sent. */}
          {!state.isRunning && <div class="text-[0.8rem] text-fg-subtle">Stopped: queued messages are sent after your next message</div>}
        </div>
      )}
    </>
  );

  return (
    <ComposerBox
      draftKey={`chat:${chatId}`}
      envId={envId}
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
      onStop={() => void runAction(() => apiForSession(chatId).abort(chatId), "Could not stop")}
      above={above}
      toolbarExtra={<ContextMeter usage={state.contextUsage} cost={state.sessionStats?.cost} compacting={state.isCompacting} model={state.model} />}
      slash={{ commands: slashCommands, chatId, projectId, navigate }}
      mentions={{ projectId, envId }}
      shell={capabilities.shell ? { run: runShell } : undefined}
      askAside={capabilities.sideQuestions === true && !lockedReason ? (question) => askSideQuestion(chatId, question) : undefined}
      steering={capabilities.steering !== false}
      class={className}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------------------------

export interface NewChatComposerProps {
  projectId: string | null;
  /** The environment a standalone chat runs on (I-123; a project chat uses its project's). */
  envId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  class?: string;
}

const NEW_CHAT_COMMANDS = builtinCommands(false);
/** Every built-in name: harness commands with these names stay hidden in new chats too. */
const BUILTIN_NAMES = new Set(builtinCommands(true).map((c) => c.name));

function NewChatComposer({ projectId, envId: chosenEnv, placeholder, autoFocus, class: className }: NewChatComposerProps) {
  const navigate = useNavigate();
  // I-123: pickers follow the host (the project's environment, or the one chosen for a standalone chat).
  const envId = projectId ? envIdOfProject(projectId) : (chosenEnv ?? undefined);
  const shell = shellOf(envId);
  const models = visibleModelsOf(shell);
  const defaults = shell.settings.value.models;
  const [pickedModel, setPickedModel] = useState<ModelRef | null>(null);
  const [pickedLevel, setPickedLevel] = useState<ThinkingLevel | null>(null);
  const [busy, setBusy] = useState(false);

  // The agent picked in the context bar (I-119); ACP agents choose their own model.
  const target = newChatHarnessFor(envId);
  const otherHarness = target && !target.isDefault ? target.id : undefined;
  const usesModels = target?.capabilities.models !== false;

  // No agent yet: built-ins that work without a chat + the folder's harness commands (I-043).
  // Those are the default harness's; another agent's commands are only known once its chat runs.
  const folderCommands = useFolderCommands(projectId, envId);
  const slashCommands = useMemo(
    () => mergeCommands(NEW_CHAT_COMMANDS, otherHarness ? [] : (folderCommands ?? []).filter((c) => !BUILTIN_NAMES.has(c.name))),
    [folderCommands, otherHarness],
  );

  // Glade's default model, else ("Default") the harness's own default (I-050), else the first.
  const defaultModel = defaults.defaultModel && models.some((m) => sameModel(m, defaults.defaultModel)) ? defaults.defaultModel : null;
  const harness = shell.harnessDefaults.value;
  const harnessModel = !defaultModel && harness?.model ? harness.model : null;
  const first = models[0];
  const model: ModelRef | null = pickedModel ?? defaultModel ?? harnessModel ?? (first ? { provider: first.provider, id: first.id } : null);
  // The harness's default may be hidden from the picker; still describe it correctly.
  const info = modelInfo(models, model) ?? modelInfo(shell.models.value, model);
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
      }, envId);
      if (withFiles) {
        const sessionId = created.session.session.id;
        const sent = await runAction(
          async () => apiForSession(sessionId).prompt(sessionId, { text: await attachFilesToText(sessionId, text, files), images: images.length ? images : undefined }),
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
      draftKey={`new:${projectId ?? (envId && !isLocalEnvironment(envId) ? `@${envId}` : "")}`}
      envId={envId}
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
      mentions={{ projectId, envId }}
      class={className}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------

export type ComposerProps = { placeholder?: string; autoFocus?: boolean; class?: string } & (
  | { chatId: string; projectId?: never }
  | { chatId?: null; projectId: string | null; /** Standalone chats: the environment (I-123). */ envId?: string | null }
);

export function Composer(props: ComposerProps) {
  if (props.chatId) {
    return <ChatComposer chatId={props.chatId} placeholder={props.placeholder} autoFocus={props.autoFocus ?? true} class={props.class} />;
  }
  return <NewChatComposer projectId={props.projectId ?? null} envId={(props as { envId?: string | null }).envId} placeholder={props.placeholder} autoFocus={props.autoFocus ?? true} class={props.class} />;
}
