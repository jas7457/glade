/**
 * Public surface of the workspace feature (I-036): the tabbed workspace screen and tab actions.
 *   - <WorkspaceView workspaceId sessionId>  header + main tabs (left) + sub-agent tabs (right)
 *   - openNewTab / closeTab / focusMainTab   tab actions (also used by shortcuts)
 */
export { WorkspaceView, type WorkspaceViewProps } from "./WorkspaceView";
export { closeTab, focusMainTab, focusSubagentTab, openNewTab, saveLayout, toggleMaximized, maximizedGroup } from "./layout-actions";
export type { TabGroupId } from "./layout";
