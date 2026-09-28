/**
 * Client-side order of lists that mix environments (I-123 §5.1: one list, not grouped, free
 * drag-and-drop order across environments). Kept per device in localStorage as a list of keys
 * `envId:itemId` per list ("projects", "pins:standalone").
 *
 * Each environment keeps its own order on its server (so its other clients agree); this device
 * only remembers how the environments are *interleaved*: the stored keys are "slots". Merging
 * walks the slots and fills each with the next item of that slot's environment (in the server's
 * order); items without a slot follow, environment by environment. With one environment the
 * result is exactly the server's order, and a reorder by another client of an environment
 * still shows here.
 *
 * Portable client core (F-022).
 */
import { signal } from "@preact/signals";

export type OrderKey = string;

export const orderKey = (envId: string, id: string): OrderKey => `${envId}:${id}`;

/** The environment part of a key (ids never contain ":" before the env part is cut). */
export function keyEnv(key: OrderKey): string {
  const i = key.indexOf(":");
  return i === -1 ? "" : key.slice(0, i);
}

/**
 * Merge per-environment ordered lists using the stored slots. `envOrder` lists environments in
 * the order their unslotted items are appended (local first).
 */
export function interleave<T>(slots: readonly OrderKey[], perEnv: ReadonlyMap<string, readonly T[]>, envOrder: readonly string[]): T[] {
  const queues = new Map([...perEnv].map(([env, items]) => [env, items.slice()]));
  const out: T[] = [];
  for (const key of slots) {
    const queue = queues.get(keyEnv(key));
    const next = queue?.shift();
    if (next !== undefined) out.push(next);
  }
  const envs = [...envOrder, ...[...queues.keys()].filter((e) => !envOrder.includes(e))];
  for (const env of envs) out.push(...(queues.get(env) ?? []));
  return out;
}

const STORAGE_KEY = "glade.order";

function readAll(): Record<string, OrderKey[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, OrderKey[]>) : {};
  } catch {
    return {};
  }
}

/** Stored slot lists by list name. */
export const clientOrders = signal<Record<string, OrderKey[]>>(readAll());

export function setClientOrder(list: string, keys: OrderKey[]): void {
  clientOrders.value = { ...clientOrders.value, [list]: keys };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clientOrders.value));
  } catch {
    /* storage unavailable */
  }
}

/** Tests: forget the stored order. */
export function resetClientOrders(): void {
  clientOrders.value = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
