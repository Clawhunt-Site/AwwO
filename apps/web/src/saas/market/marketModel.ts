// Which model a node runs once a market Agent is put on it. An Agent names the model it was made with; where its author
// locked it, the server runs that model or refuses (market_agent_model_unavailable), and otherwise it is a suggestion the
// node takes only where this workspace offers it and AwwO may choose it by itself: a model only a person may pick
// (canvas/userChosenModels.ts) is never put on a node unasked. A locked one the reader is shown before choosing the Agent.
import { automaticEntry, SANDBOX_RUNTIME } from '../../canvas/nodeRuntime';
import type { ModelPaletteSelection } from '../../canvas/modelPalette';
import type { MarketModel } from '../marketApi';
import type { MarketT } from './marketText';

export type MarketModelDecision =
  /** The node takes this model (runtime, model and effort as its catalogue offers them). */
  | { kind: 'apply'; runtime: string; model: string; effort: string; label: string; userChosen: boolean }
  /** The node keeps its own model: the Agent names none, its suggestion is not one AwwO puts on a node here, or the
   *  workspace's models could not be read (`unknown`). */
  | { kind: 'keep'; reason: 'none' | 'not-offered' | 'user-chosen' | 'unknown'; label: string }
  /** A locked model this workspace cannot run: the server would refuse the Agent. */
  | { kind: 'blocked'; label: string };

type Entry = Pick<ModelPaletteSelection, 'runtime' | 'model' | 'available' | 'label' | 'displayName' | 'efforts' | 'userChosen'>;

/** `catalogue` null: the workspace's models could not be read, so a suggestion is left alone and a locked model goes to
 *  the server as the Agent names it (the server runs it or says why not). */
export function marketModelDecision(model: MarketModel, catalogue: ReadonlyArray<Entry> | null): MarketModelDecision {
  if (!model.id) return { kind: 'keep', reason: 'none', label: '' };
  if (!catalogue) return model.locked ? { kind: 'apply', runtime: model.runtime, model: model.id, effort: model.effort, label: model.id, userChosen: false }
    : { kind: 'keep', reason: 'unknown', label: model.id };
  const offered = catalogue.filter(entry => entry.model === model.id && entry.runtime !== SANDBOX_RUNTIME);
  const exact = offered.find(item => item.runtime === model.runtime && item.available);
  // A locked model runs on its own runtime, at its own effort, and no other: the server puts the version's runtime,
  // model and effort on the node, and refuses a workspace that cannot run that one.
  const entry = model.locked ? exact : exact ?? automaticEntry(model.id, offered);
  const label = entry ? entry.displayName || entry.label : offered[0]?.displayName || offered[0]?.label || model.id;
  if (!entry || (model.locked && model.effort && !entry.efforts?.includes(model.effort))) {
    return model.locked ? { kind: 'blocked', label } : { kind: 'keep', reason: 'not-offered', label };
  }
  if (entry.userChosen === true && !model.locked) return { kind: 'keep', reason: 'user-chosen', label };
  const effort = model.effort && entry.efforts?.includes(model.effort) ? model.effort : '';
  return { kind: 'apply', runtime: entry.runtime, model: entry.model, effort, label, userChosen: entry.userChosen === true };
}

/** What the decision does to the node, said before the reader chooses the Agent. */
export function decisionNote(decision: MarketModelDecision, locked: boolean, t: MarketT): string {
  if (decision.kind === 'blocked') return t(`作者锁定了模型「${decision.label}」，你的工作区用不了它，所以这个 Agent 在这里用不了。`,
    `Its author locked the model “${decision.label}”, which your workspace cannot use, so this Agent cannot be used here.`);
  if (decision.kind === 'keep') return decision.reason === 'none' ? t('这个 Agent 没有指定模型，节点保留它现在的模型。', 'This Agent names no model, so the node keeps its own.')
    : decision.reason === 'unknown' ? t(`暂时读不到你的模型清单，节点保留它现在的模型（推荐的是「${decision.label}」）。`,
      `Your model list cannot be read right now, so the node keeps its own model (the suggestion is “${decision.label}”).`)
    : decision.reason === 'user-chosen' ? t(`推荐模型「${decision.label}」只能由你自己选择，节点保留它现在的模型；想用它的话，在节点上自己选。`,
      `The suggested model “${decision.label}” is one only you may choose, so the node keeps its own; pick it on the node yourself if you want it.`)
      : t(`推荐模型「${decision.label}」不在你的模型清单里，节点保留它现在的模型。`, `The suggested model “${decision.label}” is not in your model list, so the node keeps its own.`);
  if (locked) return decision.userChosen
    ? t(`作者锁定了模型「${decision.label}」，这个模型的请求由它的服务商处理；选用这个 Agent 就是选用这个模型。`,
      `Its author locked the model “${decision.label}”, whose requests its own provider handles; choosing this Agent chooses that model.`)
    : t(`作者锁定了模型「${decision.label}」，节点会用这个模型运行。`, `Its author locked the model “${decision.label}”, which the node will run on.`);
  return t(`节点会换成推荐模型「${decision.label}」，之后可以在节点上换成你能用的其他模型。`,
    `The node switches to the suggested model “${decision.label}”; you can switch it to another model you can use afterwards.`);
}
