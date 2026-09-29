/**
 * Harness-agnostic model + reasoning types.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelInfo extends ModelRef {
  /** Harness that lists the model (`HarnessInfo.id`, I-155; set by `GET /api/models`). */
  harness?: string;
  /** Human readable name, e.g. "Claude Sonnet 4". */
  name: string;
  /** Supported thinking levels, in ascending order. `["off"]` for non-reasoning models. */
  thinkingLevels: ThinkingLevel[];
  /** Accepted input modalities. */
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  /** Limits for attached images; clients downscale to fit before sending. */
  imageLimits?: ImageLimits;
}

export interface ImageLimits {
  maxWidth: number;
  maxHeight: number;
  /** Maximum encoded size in bytes (of the decoded image data, not base64). */
  maxBytes: number;
  /** JPEG quality 1-100 used when re-encoding. */
  jpegQuality: number;
}

/** Used when a model doesn't report its own limits. */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
  jpegQuality: 80,
};

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

export function parseModelKey(key: string): ModelRef | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/**
 * Pick the closest supported thinking level: the requested one if available, otherwise the
 * next higher level, otherwise the next lower one.
 */
export function clampThinkingLevel(available: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (available.includes(level)) return level;
  const idx = THINKING_LEVELS.indexOf(level);
  for (let i = idx + 1; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i]!;
    if (available.includes(candidate)) return candidate;
  }
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i]!;
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}
