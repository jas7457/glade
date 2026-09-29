import { signal } from "@preact/signals";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  level: "info" | "warning" | "error" | "success";
  message: string;
  /** Optional bold first line. */
  title?: string;
  /** Optional button (e.g. "View"). Clicking it also dismisses the toast. */
  action?: ToastAction;
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

export function notify(level: Toast["level"], message: string, timeoutMs = level === "error" ? 8000 : 4000): void {
  showToast({ level, message, timeoutMs });
}

/** Full-featured variant of `notify` (title + action). Returns the toast id. */
export function showToast({
  timeoutMs,
  ...fields
}: Omit<Toast, "id"> & { timeoutMs?: number }): number {
  const toast: Toast = { id: nextId++, ...fields };
  toasts.value = [...toasts.value, toast];
  setTimeout(() => dismissToast(toast.id), timeoutMs ?? (toast.level === "error" ? 8000 : 4000));
  return toast.id;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
