import type { AssembleNode } from './canvasDoc';
import { templateIssues, type AssembleInputView } from './assembleNode';
import { NodeDeliverables } from './NodeDeliverables';
import { useCanvasI18n } from './i18n';
import type { StudioEntry } from './studio/studioModel';
import './assemble-node.css';

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

/** An assemble node's card body: what each slot will take and from where, and what it assembled last. */
export function AssembleTileBody({ node, inputs, expanded, canvasEntries }: {
  node: AssembleNode;
  inputs: ReadonlyArray<AssembleInputView>;
  expanded: boolean;
  canvasEntries?: ReadonlyArray<StudioEntry>;
}) {
  const { t } = useCanvasI18n();
  const issues = templateIssues(node.template, node.contract.inputs.map(field => field.id));
  const total = inputs.reduce((sum, input) => sum + (input.used ? input.bytes : 0), 0);
  return <div className="awwo-assemble-body" data-testid={`assemble-body-${node.id}`}>
    <p className="awwo-assemble-note">{t('tile.assembleNoModel')}</p>
    <ul className="awwo-assemble-inputs" aria-label={t('assemble.inputs')}>
      {inputs.map(input => <li key={input.id} className={input.used ? undefined : 'is-unused'}>
        <span className="awwo-assemble-slot">{input.label}</span>
        <span className="awwo-assemble-source">{input.source ? t('tile.assembleWired', { title: input.source }) : t('tile.assembleLocal')}</span>
        <span className="awwo-assemble-size">{!input.used ? t('tile.assembleUnused') : input.bytes ? size(input.bytes) : t('tile.assembleEmpty')}</span>
      </li>)}
    </ul>
    {issues.length ? <p className="awwo-contract-errors" role="alert">{t('assemble.issues', { issues: issues.join(' ') })}</p> : null}
    {expanded ? node.lastOutput
      ? <NodeDeliverables node={node} readOnly presentation="result" canvasEntries={canvasEntries} />
      : <p className="awwo-assemble-waiting">{t('tile.assembleWaiting')}{total ? ` · ${size(total)}` : ''}</p>
      : null}
  </div>;
}
