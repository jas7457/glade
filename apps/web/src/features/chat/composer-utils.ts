/**
 * Pure helpers for the composer: send-key handling, image attachments, labels.
 */
import type { PromptImage, Settings, ThinkingLevel } from "@pi-ui/protocol";

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

/** Read an image file as base64 (without the `data:` prefix). */
export function readImageFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve({
        id: `att-${++attachmentSeq}`,
        name: file.name,
        mimeType: file.type || "image/png",
        data: comma >= 0 ? url.slice(comma + 1) : url,
      });
    };
    reader.readAsDataURL(file);
  });
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
