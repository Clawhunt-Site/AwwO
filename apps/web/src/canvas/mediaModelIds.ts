// A media model's id as the API names it: `<generator>.<model>`, the generator being one of the services AwwO makes
// pictures, clips and 3D models with (rh, tripo, xt, jm). An id names that service and the model family, which users
// never see (owner decisions 2026-10-11), so nothing shows one: modelNames.ts names a media model generically, and a
// view that shows a run's raw record hides the ids in it. No imports, so any module (canvasDoc.ts too) can use it.
// This is not the media catalogue's admission rule: mediaCatalog.ts keeps its own list of the ids it accepts.
const ID = '(?:rh|tripo|xt|jm)\\.[a-z0-9][a-z0-9-]{0,62}';
const WHOLE = new RegExp(`^${ID}$`);
const WITHIN = new RegExp(`(?<![A-Za-z0-9_.-])${ID}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'g');

/** What stands in for a media model's id where a raw record is shown. */
export const HIDDEN_MEDIA_MODEL = '[media model]';

/** Whether a value is a media model's id. */
export const isMediaModelId = (model: unknown): model is string => typeof model === 'string' && WHOLE.test(model);

/** A raw record (a node's output, an evidence preview) with every media model id in it replaced by a placeholder. */
export function hideMediaModelIds(text: string): string {
  return text.replace(WITHIN, HIDDEN_MEDIA_MODEL);
}
