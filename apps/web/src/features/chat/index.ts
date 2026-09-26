/**
 * Public surface of the chat feature. The app shell only imports from here.
 *   - <ChatView chatId>          existing chat: header + transcript + composer
 *   - <NewChatView projectId>    empty state + composer; creates the chat on first send
 *   - <Transcript chatId>, <Composer chatId | projectId> are reusable building blocks
 *   - <Markdown text streaming?> is the shared markdown renderer
 *   - DEFAULT_GROUPING_OPTIONS controls how tool calls are grouped
 */
export { ChatView } from "./ChatView";
export { NewChatView } from "./NewChatView";
export { Transcript, type TranscriptProps } from "./Transcript";
export { Composer, ComposerBox, type ComposerProps, type ComposerBoxProps } from "./Composer";
export { Markdown, CodeView, type MarkdownProps } from "./Markdown";
export { DEFAULT_GROUPING_OPTIONS, groupTranscript, type GroupingOptions, type RenderItem, type TurnPart } from "./grouping";
export { toolRenderers, type ToolRenderer, type ToolBodyProps } from "./tools/renderers";
export { toolSummarizers } from "./tools/summaries";
