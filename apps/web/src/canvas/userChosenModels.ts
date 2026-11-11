import type { CanvasPlanModelChoice, CanvasPlanModels } from './canvasPlan';
import type { ModelPaletteSelection } from './modelPalette';

/** Models only a user may choose: the API marks them `userChosen` (the DeepSeek API's, whose requests DeepSeek processes
 *  in China; backend tenant_models.go userChosenProvider). ClawHunt's privacy policy (clause 08) promises that a request
 *  goes to one only when a DeepSeek model is selected for it, and that AwwO never moves a request there by itself, so
 *  every choice the page makes by itself leaves them out: the model a task starts on when the reader picked none (and the
 *  default a refused task is offered), the models Jev assigns to the roles it adds, the models a canvas plan may put a node
 *  on, and the sandbox model a node moves to. Only the reader's own pick in a model picker selects one. */
export function automaticChoices<T extends { userChosen?: boolean }>(entries: ReadonlyArray<T>): T[] {
  return entries.filter(entry => entry.userChosen !== true);
}

/** Anthropic's Claude Fable models, by id alone as the API knows them (backend tenant_models.go userChosenModel): after
 *  an optional `bedrock.` prefix the id starts with `claude-fable-`. The API marks them `userChosen` too, for another
 *  reason than DeepSeek's: AWS keeps the inputs and outputs of every Claude Fable request for up to 30 days and its staff
 *  may read what its systems flag (clause 08, "Claude Fable models"). Wherever a person has one chosen in a model picker,
 *  the page says so beside it (ClaudeFableNote.tsx), and says nothing that contradicts the clause. */
export function isClaudeFableModel(id: string | null | undefined): boolean {
  return typeof id === 'string' && (id.startsWith('bedrock.') ? id.slice('bedrock.'.length) : id).startsWith('claude-fable-');
}

/** A Claude Fable model AwwO runs through Amazon Bedrock: its catalog id (`bedrock.claude-fable-…`). The sentence below
 *  is about these alone: a Claude Fable id without the prefix is not one AwwO's service lists (the gateway's were
 *  withdrawn on 2026-10-07), and in the local edition it is a person's own connection, whose requests AWS never sees. */
export function isBedrockClaudeFableModel(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('bedrock.claude-fable-');
}

/** What the page says beside such a model a person has chosen, in the clause's own terms ([zh, en]), and the name of
 *  the clause it points to. */
export const CLAUDE_FABLE_SENTENCE = ['Claude Fable 的请求由 AWS 保存最长 30 天，被系统标记的内容可能由 AWS 人员查看。',
  'AWS keeps Claude Fable requests for up to 30 days, and its staff may read content its systems flag.'] as const;
export const PRIVACY_CLAUSE_NAME = ['隐私政策第 08 条', 'Privacy policy, clause 08'] as const;

/** The models a canvas plan may put a node on, from the canvas's palette: each entry with its name and effort levels,
 *  less the models only a user may choose. The planner never sees those; they are named apart (`userChosen`, entries of
 *  the same shape) so that a plan's set_model asking for one says why the node was left as it was, and a node the reader
 *  set on one keeps it at the effort a plan asks for where its entry offers it (canvasPlan.ts applyCanvasPlan). */
export function planModelsOf(palette: ReadonlyArray<ModelPaletteSelection>): CanvasPlanModels & { choices: Array<CanvasPlanModelChoice & { requiresUpgrade?: boolean }> } {
  const choice = (entry: ModelPaletteSelection) => ({ runtime: entry.runtime, model: entry.model, available: entry.available, name: entry.displayName || entry.label,
    ...(entry.efforts ? { efforts: entry.efforts } : {}), ...(entry.requiresUpgrade ? { requiresUpgrade: true } : {}) });
  return {
    choices: automaticChoices(palette).map(choice),
    userChosen: palette.filter(entry => entry.userChosen === true).map(choice),
  };
}
