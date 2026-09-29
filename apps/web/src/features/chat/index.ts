/**
 * Public surface of the chat feature. The app shell only imports from here.
 *   - <ChatView workspaceId sessionId>  existing chat: header + transcript + composer
 *   - <NewChatView projectId>    empty state + composer; creates the chat on first send
 *   - <Transcript chatId>, <Composer chatId | projectId> are reusable building blocks
 *   - <Markdown text streaming?> is the shared markdown renderer
 *   - DEFAULT_GROUPING_OPTIONS controls how tool calls are grouped
 */
export { ChatView } from "./ChatView";
export { NewChatView } from "@glade/app-core/features/chat/NewChatView";
export { Transcript, type TranscriptProps } from "@glade/app-core/features/chat/Transcript";
export { Composer, ComposerBox, type ComposerProps, type ComposerBoxProps } from "@glade/app-core/features/chat/Composer";
export { Markdown, CodeView, type MarkdownProps } from "@glade/app-core/features/chat/Markdown";
export { DEFAULT_GROUPING_OPTIONS, groupTranscript, type GroupingOptions, type RenderItem, type TurnPart } from "@glade/app-core/features/chat/grouping";
export { toolRenderers, type ToolRenderer, type ToolBodyProps } from "@glade/app-core/features/chat/tools/renderers";
export { toolSummarizers } from "@glade/app-core/features/chat/tools/summaries";
