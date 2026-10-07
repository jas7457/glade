/**
 * Pure helpers for the composer: send-key handling, attachments (images inline, other files by
 * reference, I-090), labels.
 */
import type { ImageLimits, PromptImage, ThinkingLevel } from "@glade/protocol";
import { prepareImage } from "./image-resize";

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Whether Enter sends in the composer (I-153, I-200; no settings), and with which modifiers:
 * ↩ / ⌘↩ (or Ctrl↩) / ⌥↩ send in the mode `sendModeFor` picks for them (send-mode.ts); ⇧↩ inserts
 * a new line (`null`: the textarea's default). Never while an IME composition is active.
 */
export function sendKeyModifiers(e: KeyLike): { meta: boolean; alt: boolean } | null {
  if (e.key !== "Enter") return null;
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.shiftKey) return null;
  return { meta: e.metaKey || e.ctrlKey, alt: e.altKey };
}

export interface Attachment extends PromptImage {
  id: string;
  name: string;
}

let attachmentSeq = 0;

/** Read an image file, downscaled/re-encoded to fit `limits` (see image-resize.ts). */
export async function readImageFile(file: File, limits?: ImageLimits): Promise<Attachment> {
  const image = await prepareImage(file, limits);
  return { id: `att-${++attachmentSeq}`, name: file.name, mimeType: image.mimeType, data: image.data };
}

/** A file attached by reference, waiting in the composer until the message is sent (I-090). */
export interface PendingFile {
  id: string;
  name: string;
  file: File;
}

/**
 * Sort attached files: images go inline when the model accepts them (else they're attached by
 * reference like any other file); files over `maxBytes` are refused.
 */
export function splitAttachableFiles(
  list: FileList | File[] | null | undefined,
  supportsImages: boolean,
  maxBytes: number,
): { images: File[]; files: PendingFile[]; tooLarge: File[] } {
  const images: File[] = [];
  const files: PendingFile[] = [];
  const tooLarge: File[] = [];
  for (const file of Array.from(list ?? [])) {
    if (supportsImages && file.type.startsWith("image/")) images.push(file);
    else if (file.size > maxBytes) tooLarge.push(file);
    else files.push({ id: `file-${++attachmentSeq}`, name: file.name, file });
  }
  return { images, files, tooLarge };
}

/** `1536` → `1.5 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function thinkingLabel(level: ThinkingLevel): string {
  return THINKING_LABELS[level] ?? level;
}

/** A composer text in shell mode (I-076): `!cmd` = shared with the agent, `!!cmd` = not shared. */
export interface ShellInput {
  command: string;
  shareWithAgent: boolean;
}

/** `!cmd` / `!!cmd` → the command (trimmed; may be empty while typing), else `null`. */
export function parseShellInput(text: string): ShellInput | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!!")) return { command: trimmed.slice(2).trim(), shareWithAgent: false };
  if (trimmed.startsWith("!")) return { command: trimmed.slice(1).trim(), shareWithAgent: true };
  return null;
}
