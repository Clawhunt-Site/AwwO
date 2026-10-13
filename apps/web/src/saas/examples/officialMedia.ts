import type { MediaParams } from '../../canvas/canvasDoc';
import type { Localized } from './officialWorkflows';

/** An image, video or 3D node of a case canvas: it generates from its own prompt (its draft) when the canvas
 * runs, or alone when a member presses Send, and its result is wired into the pages that show it (`feeds`): each of
 * those nodes gets a text input that reads the stored files as `<node id>/<file name>` paths, which the page uses in
 * its img, video or CSS. The wire is soft: a picture that was not made (a workspace whose allowance refuses it, a
 * failed generation) leaves the page a note instead, and the page is made without it. */
export interface OfficialMediaNode {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'model3d';
  readonly title: Localized;
  readonly prompt: Localized;
  readonly model: string;
  readonly params?: MediaParams;
  readonly column: number;
  readonly row: number;
  /** The case's nodes whose page shows this asset. */
  readonly feeds?: ReadonlyArray<string>;
  /** Image nodes of the same case whose picture this one starts from, wired into its `reference` input: a colour
   * version of that picture, or a clip of the subject it shows. The wire is a hard one: without the picture there is
   * nothing to start from, so this node waits for it. */
  readonly references?: ReadonlyArray<string>;
}
