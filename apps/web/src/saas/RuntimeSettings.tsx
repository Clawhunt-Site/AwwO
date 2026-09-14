import { useEffect, useState } from 'react';
import { api, saasErrorMessage, tenantPath } from './api';
import { useSaaSPreferences } from './preferences';
import './admin.css';
import { SaaSAppearanceControl } from './SaaSAppearance';
import { runtimeDefinitions, runtimeModels, type SaaSRuntimeStatus } from './runtimeCatalog';

/** The catalogue is workspace scoped, so the tenant is required rather than
 * optional: without it the server cannot apply this workspace's model
 * entitlement and would have to answer with an unfiltered catalogue. */
export function RuntimeSettings({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const [runtime, setRuntime] = useState<SaaSRuntimeStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setRuntime(null); setError('');
    api<SaaSRuntimeStatus>(tenantPath(tenantId, '/runtime'), { signal: controller.signal }).then(value => {
      runtimeDefinitions(value).forEach(definition => runtimeModels(value, definition.id));
      if (!controller.signal.aborted) setRuntime(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [revision, tenantId]);
  if (appearanceOpen) return <SaaSAppearanceControl standalone onClose={() => setAppearanceOpen(false)} />;
  return <div className="saas-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="saas-runtime-title" className="saas-card"><h2 id="saas-runtime-title">{t('工作区运行设置', 'Workspace runtime settings')}</h2>
    {error ? <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p> : !runtime ? <p role="status">{t('正在读取运行服务…', 'Loading runtime…')}</p> : <>{runtimeDefinitions(runtime).map(definition => <section key={definition.id} aria-label={definition.name}><dl className="saas-runtime-values"><dt>{t('执行引擎', 'Engine')}</dt><dd>{definition.name}</dd><dt>{t('服务状态', 'Service status')}</dt><dd>{definition.available && definition.configured ? t('配置就绪', 'Configured') : t('尚未就绪', 'Unavailable')}</dd><dt>{t('可选模型', 'Available models')}</dt><dd>{runtimeModels(runtime, definition.id).map(model => model.label || model.name || model.id).join(', ') || t('暂无', 'None')}</dd></dl></section>)}
      {runtime.reason && <p role="status">{saasErrorMessage(runtime.reason, locale)}</p>}<p>{t('模型在节点的运行配置中选择，人格与输入输出契约沿用节点设置。修改已绑定节点的配置会创建新绑定，已有会话仍可查看。', 'Choose a model in each node’s runtime configuration. Persona and input/output contracts remain node settings. Changing a bound node’s configuration creates a new binding while preserving prior sessions.')}</p>
      <p>{t('模型连接由服务管理员统一配置。此处刷新只检查服务配置；模型是否实际可用，以画布中的运行结果为准。', 'Model connections are managed by the service administrator. Refresh checks service configuration; an actual canvas run verifies model connectivity.')}</p></>}
    <SaaSAppearanceControl onOpenDialog={() => setAppearanceOpen(true)} />
    <button onClick={() => setRevision(value => value + 1)}>{t('刷新运行状态', 'Refresh runtime status')}</button><button autoFocus onClick={onClose}>{t('关闭', 'Close')}</button>
  </section></div>;
}
