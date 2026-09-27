/**
 * Pure helpers for the composer: send-key handling, image attachments, labels.
 */
import type { ImageLimits, PromptImage, Settings, ThinkingLevel } from "@glade/protocol";
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
 * Whether a keydown should send the message.
 *  - "enter":     Enter sends; Shift/Alt+Enter insert a newline (⌘/Ctrl+Enter also send).
 *  - "mod-enter": ⌘/Ctrl+Enter sends; plain Enter inserts a newline.
 * Never while an IME composition is active.
 */
export function isSendKey(e: KeyLike, sendKey: Settings["general"]["sendKey"]): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing || e.keyCode === 229) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (sendKey === "mod-enter") return mod;
  return !e.shiftKey && !e.altKey;
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

export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
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
