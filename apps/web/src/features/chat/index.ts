/**
 * Public surface of the chat feature. The app shell only imports from here.
 *   - <ChatView chatId>          existing chat: header + transcript + composer
 *   - <NewChatView projectId>    empty state + composer; creates the chat on first send
 *   - <Transcript chatId>, <Composer chatId> are reusable building blocks.
 */
export { ChatView } from "./ChatView";
export { NewChatView } from "./NewChatView";
