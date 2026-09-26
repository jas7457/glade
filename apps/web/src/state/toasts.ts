import { signal } from "@preact/signals";

export interface Toast {
  id: number;
  level: "info" | "warning" | "error" | "success";
  message: string;
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

export function notify(level: Toast["level"], message: string, timeoutMs = level === "error" ? 8000 : 4000): void {
  const toast: Toast = { id: nextId++, level, message };
  toasts.value = [...toasts.value, toast];
  setTimeout(() => dismissToast(toast.id), timeoutMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
