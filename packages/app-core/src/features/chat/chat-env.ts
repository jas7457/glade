/**
 * The environment of the chat being rendered (I-123), for leaf components that act on the host
 * (e.g. revealing an attached file in Finder only when the chat runs on this machine). Provided
 * by the transcript; `null` = unknown (treated as local).
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";

export const ChatEnvContext = createContext<string | null>(null);

export function useChatEnv(): string | null {
  return useContext(ChatEnvContext);
}

/** The folder the rendered chat runs in (its workspace's cwd), for shortening `cd` in tool rows (I-152). */
export const ChatCwdContext = createContext<string | null>(null);

export function useChatCwd(): string | null {
  return useContext(ChatCwdContext);
}
