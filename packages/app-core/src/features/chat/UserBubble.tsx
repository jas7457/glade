/**
 * A sent user message in the transcript: images, files attached by reference and the text.
 *
 * - Attached files (I-090): the prompt's trailing `Attached file: /abs/path` lines are shown as
 *   file chips (icon by type, name; tooltip = full path; click = reveal in Finder) instead of
 *   the raw lines.
 * - `@path` mentions (I-092) inside the text are shown as small path chips; the stored text is
 *   unchanged (selecting and copying still gives the `@path`).
 * - `inline code` and ``` fenced blocks look like they do in replies (I-194); nothing else is
 *   treated as Markdown, so pasted text stays as typed.
 * - Sub-agent reports arrive as prompts but aren't the user's words: they render as cards
 *   (AgentMessageCard, I-075).
 * - Long text collapses after ~15 lines with "Show more" (ui/Clamp, I-109); images open in a
 *   lightbox (I-110); the time shows on hover (I-111).
 * - Bookmarks (I-203): the bookmark toggle next to the time on hover, a ribbon beside a
 *   bookmarked bubble (click removes, I-206); `data-anchor` lets the transcript's message menu find it (MessageBookmark.tsx).
 */
import { memo } from "preact/compat";
import { useMemo } from "preact/hooks";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from "lucide-preact";
import { attachmentName, parseAgentMessage, parseAttachedFiles, type ImageBlock, type UserMessage } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { apiFor, isThisMachine } from "@glade/app-core/state/env-api";
import { useChatEnv } from "./chat-env";
import { notify } from "@glade/app-core/state/toasts";
import { Chip, Clamp } from "@glade/app-core/ui";
import { AgentMessageCard } from "./AgentMessageCard";
import { fenced, Markdown } from "./Markdown";
import { splitUserCode } from "./user-code";
import { splitMentions } from "./mentions/parse";
import { useImageLightbox } from "./ImageLightbox";
import { useImageSrc } from "./image-src";
import { MessageTime } from "./MessageTime";
import { BookmarkRibbon, MessageBookmarkButton, anchorKey } from "./MessageBookmark";

const EXTENSION_ICONS: Array<[RegExp, LucideIcon]> = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?|ico|avif)$/i, FileImage],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|iso)$/i, FileArchive],
  [/\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i, FileAudio],
  [/\.(mp4|mov|m4v|avi|mkv|webm)$/i, FileVideo],
  [/\.(csv|tsv|xlsx?|numbers|ods)$/i, FileSpreadsheet],
  [/\.(pdf|txt|md|markdown|rtf|docx?|pages|odt|log|tex)$/i, FileText],
  [
    /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|ya?ml|toml|xml|html?|css|scss|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|sql|lua|vue|svelte)$/i,
    FileCode,
  ],
];

/** An icon for a file by its extension (folders: `kind: "dir"`). */
export function fileIcon(name: string, kind: "file" | "dir" = "file"): LucideIcon {
  if (kind === "dir") return Folder;
  return EXTENSION_ICONS.find(([re]) => re.test(name))?.[1] ?? File;
}

function revealFile(path: string, envId: string | null) {
  apiFor(envId).revealFile(path).catch((err: Error) => notify("error", `Couldn't show the file: ${err.message}`));
}

/** A file attached by reference, on a sent message. */
export function AttachedFileChip({ path }: { path: string }) {
  const name = attachmentName(path);
  const Icon = fileIcon(name);
  // Show in Finder only when the chat runs on this machine (I-123/I-124).
  const env = useChatEnv();
  const canReveal = isThisMachine(env, "reveal");
  return <Chip icon={<Icon />} label={name} title={path} onClick={canReveal ? () => revealFile(path, env) : undefined} />;
}

/** Message text with `@path` mentions as inline chips (I-092). */
export function MentionText({ text }: { text: string }) {
  const segments = useMemo(() => splitMentions(text), [text]);
  return (
    <>
      {segments.map((s, i) => {
        if (s.type === "text") return s.text;
        const Icon = fileIcon(s.path, s.kind);
        return (
          <Chip
            key={i}
            size="inline"
            icon={<Icon />}
            label={s.kind === "dir" ? `${s.path}/` : s.path}
            title={`${s.kind === "dir" ? "Folder" : "File"}: ${s.path}`}
          />
        );
      })}
    </>
  );
}

/** The user's text: plain, with `@path` chips, inline code chips and fenced code blocks (I-194). */
export function UserText({ text }: { text: string }) {
  const segments = useMemo(() => splitUserCode(text), [text]);
  return (
    <>
      {segments.map((s, i) => {
        if (s.type === "text") return <MentionText key={i} text={s.text} />;
        if (s.type === "code") return <code key={i} class="pi-inline-code">{s.code}</code>;
        return (
          <div key={i} class="my-1.5 whitespace-normal" data-testid="user-code-block">
            <Markdown text={fenced(s.code, s.language)} codeMaxHeight={360} />
          </div>
        );
      })}
    </>
  );
}

export const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  const images = useMemo(() => message.content.filter((b): b is ImageBlock => b.type === "image"), [message.content]);
  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
  const { text, files } = useMemo(() => parseAttachedFiles(raw), [raw]);
  // Sub-agent reports arrive as prompts but aren't the user's words (I-075).
  const agentMessage = useMemo(() => (images.length === 0 && files.length === 0 ? parseAgentMessage(raw) : null), [raw, images.length, files.length]);
  const { open, lightbox } = useImageLightbox(images);
  const anchor = useMemo(() => ({ role: "user" as const, timestamp: message.timestamp }), [message.timestamp]);
  if (agentMessage) return <AgentMessageCard message={agentMessage} />;
  const getText = () => text;
  return (
    <div class="group/msg relative mt-6 flex flex-col items-end gap-1.5 first:mt-0" data-role="user" data-anchor={anchorKey(anchor)}>
      {images.length > 0 && (
        <div class="relative flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((img, i) => (
            <ImageThumb key={i} image={img} class="max-h-40" onOpen={() => open(i)} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div class="relative flex max-w-[85%] flex-wrap justify-end gap-1.5" aria-label="Attached files">
          {files.map((path, i) => (
            <AttachedFileChip key={i} path={path} />
          ))}
        </div>
      )}
      {text && (
        <div class="relative max-w-[85%] rounded-[14px] bg-selected px-3.5 py-2 leading-[1.5]">
          <BookmarkRibbon anchor={anchor} class="top-1.5 -left-6" />
          <Clamp lines={LONG_BUBBLE_LINES} contentClass="selectable whitespace-pre-wrap break-words">
            <UserText text={text} />
          </Clamp>
        </div>
      )}
      {/* Below the message, right-aligned (agent replies: below, left-aligned). Out of flow, so hovering doesn't shift anything. */}
      <div data-aux="footer" class="absolute top-full right-0 mt-0.5 flex items-center gap-1">
        {text && <MessageBookmarkButton anchor={anchor} getText={getText} class="-my-0.5" />}
        <MessageTime timestamp={message.timestamp} />
      </div>
      {lightbox}
    </div>
  );
});

/** User bubbles longer than this collapse with "Show more" (I-109). */
export const LONG_BUBBLE_LINES = 15;

/** A transcript image; with `onOpen` it's a button that opens it large (I-110). Never wider than its container (I-131). */
export function ImageThumb({ image, class: className, onOpen }: { image: ImageBlock; class?: string; onOpen?: () => void }) {
  // Wide images scale down to the column instead of spilling out of it (I-131).
  const src = useImageSrc(image);
  const img = (
    <img
      src={src ?? undefined}
      alt=""
      class={cn("h-auto min-w-0 max-w-full rounded-[10px] border-[0.5px] border-separator object-contain", !src && "bg-control", className)}
    />
  );
  if (!onOpen) return img;
  return (
    <button
      type="button"
      aria-label="Open image"
      onClick={onOpen}
      class="flex min-w-0 max-w-full cursor-zoom-in rounded-[10px] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent"
    >
      {img}
    </button>
  );
}
