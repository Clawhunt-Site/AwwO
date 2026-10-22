// The line of a planning context that names the model the Agent nodes its plan adds without set_model take (the reader's
// choice for the canvas assistant, assistantModel.ts), which a hosted planner sizes their tasks by (planning_limits.go).
// Its own module, as both the context's writer (canvasPlanning.ts) and the hosted bridge that replays a stored request
// (saas/canvasBridge.ts) read it, and the one already imports the other.

/** The line, in each language the context is written in; the model follows it as a JSON string. */
export const NEW_NODE_LINE = { en: 'New Agent nodes you add without set_model run on: ', zh: '新增且未用 set_model 指定模型的 Agent 节点使用：' } as const;

/** What the line names where those nodes run the workspace default: the id the planner's model list and its node limits
 *  give the default ("default"). A request that names no model at all was made before requests named one. */
export const DEFAULT_NEW_NODE_MODEL = 'default';

/** The model a planning context says the nodes its plan adds take (DEFAULT_NEW_NODE_MODEL for the workspace default), or
 *  undefined where it says none (one written before it said so). A hosted plan carries it from the request its run was
 *  made from (canvasBridge.ts), which a resume replays, so its nodes take the model they were sized for, not one chosen
 *  since (canvasPlan.ts planNewNodeModel). */
export function newNodeModelOf(context: string | undefined): string | undefined {
  for (const line of (context ?? '').split('\n')) {
    for (const prefix of Object.values(NEW_NODE_LINE)) {
      if (!line.startsWith(prefix)) continue;
      try {
        const model = JSON.parse(line.slice(prefix.length));
        if (typeof model === 'string' && model) return model;
      } catch { /* not this line */ }
    }
  }
  return undefined;
}
