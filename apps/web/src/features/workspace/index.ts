/**
 * Public surface of the workspace feature (I-036): the tabbed workspace screen and tab actions.
 *   - <WorkspaceView workspaceId sessionId>  header + main tabs (left) + sub-agent tabs (right)
 *   - openNewTab / closeTab / focusMainTab   tab actions (also used by shortcuts)
 */
export { WorkspaceView, type WorkspaceViewProps } from "./WorkspaceView";
export { closeTab, closeTerminalTab, openTerminalTab, focusMainTab, focusSubagentTab, hideSubagentPane, openNewTab, openSubagent, removeSubagent, saveLayout, setChangesPanelOpen, toggleMaximized, toggleSubagentPane, maximizedGroup } from "./layout-actions";
export { renameWithAi } from "./rename-with-ai";
export type { TabGroupId } from "./layout";
export { activeTerminalId } from "./layout";
