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

/** The models a canvas plan may put a node on, from the canvas's palette: each entry with its name and effort levels,
 *  less the models only a user may choose. The planner never sees those; they are named apart (`userChosen`) so that a
 *  plan's set_model asking for one says why the node was left as it was (canvasPlan.ts applyCanvasPlan). */
export function planModelsOf(palette: ReadonlyArray<ModelPaletteSelection>): CanvasPlanModels & { choices: Array<CanvasPlanModelChoice & { requiresUpgrade?: boolean }> } {
  return {
    choices: automaticChoices(palette).map(entry => ({ runtime: entry.runtime, model: entry.model, available: entry.available, name: entry.displayName || entry.label,
      ...(entry.efforts ? { efforts: entry.efforts } : {}), ...(entry.requiresUpgrade ? { requiresUpgrade: true } : {}) })),
    userChosen: palette.filter(entry => entry.userChosen === true).map(entry => ({ model: entry.model, name: entry.displayName || entry.label })),
  };
}
