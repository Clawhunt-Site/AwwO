// Secrets & instance-settings management — a thin presentation layer over the
// kernel contract (/api/secrets/contract) and the secrets API. Surface rules:
// everything renders FROM the contract (providers, binding target types come
// from the kernel, never hardcoded), and plaintext never exists here beyond
// the controlled input fields of the create/rotate dialogs (the API cannot
// echo it back by design).
//
// PARKED SURFACE: this component is intentionally not wired into the settings
// navigation right now — end users don't manage their own agent-team
// credentials in the shipped app, so the "Secrets" tab is hidden. The kernel /
// CLI (`superclaw secret`, `superclaw instance`) remain the active surface for
// this capability; its contract test still guards the projection. Re-expose by
// restoring the `settings-secrets` nav item + section in App/SettingsSurface.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, FileClock, KeyRound, Link2, Plus, RotateCw, Trash2 } from 'lucide-react';
import { DialogShell } from '../ui/DialogShell';
import { Dropdown } from '../ui/Dropdown';

type ReadJson = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;

interface SecretSummary {
  secret_id: string;
  name: string;
  company_profile_id: string;
  provider: string;
  description: string;
  current_version: number;
  archived: boolean;
}

interface SecretBinding {
  binding_id: string;
  secret_id: string;
  target_type: string;
  target_id: string;
  config_path: string;
  required: boolean;
}

interface AccessEvent {
  event_id: string;
  action: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  occurred_at: number;
  detail: string;
}

interface SecretsContract {
  providers: Array<{ id: string; label: string; ready: boolean; notes: string }>;
  binding_target_types: string[];
  instance_settings_buckets: string[];
}

const DICT = {
  en: {
    secretsTitle: 'Company secrets',
    secretsDescription:
      'Encrypted at rest (AES-256-GCM). Values never leave the kernel: this page only ever sees the masked ledger. Consumers read a secret through an explicit binding, and every access — including refusals — is audited.',
    createSecret: 'New secret',
    name: 'Name',
    value: 'Value',
    description: 'Description',
    create: 'Create',
    rotate: 'Rotate',
    rotateTitle: 'Rotate secret',
    rotateHint: 'Stores a new version; old versions stay in the audit trail.',
    archive: 'Archive',
    restore: 'Restore',
    del: 'Delete',
    deleteConfirm: 'Delete this secret, all its versions, and its bindings? The audit trail survives.',
    bindings: 'Bindings',
    bind: 'Bind consumer',
    bindTitle: 'Grant a consumer access',
    bindHint: 'The secret lands in the consumer as this environment variable. Required bindings gate invokability: if the secret is missing, the consumer cannot take work.',
    targetType: 'Consumer type',
    targetId: 'Consumer id',
    envVar: 'Environment variable',
    required: 'Required (gates invokability)',
    unbind: 'Unbind',
    accessLog: 'Access log',
    accessLogTitle: 'Access audit',
    noEvents: 'No access events.',
    noBindings: 'No bindings yet — nothing can read this secret.',
    noSecrets: 'No secrets yet.',
    archivedPill: 'archived',
    instanceTitle: 'Instance settings',
    instanceDescription: 'Singleton instance configuration in two buckets. Values are JSON.',
    bucket: 'Bucket',
    key: 'Key',
    set: 'Set',
    unset: 'Unset',
    emptyBucket: '(empty)',
    cancel: 'Cancel',
    close: 'Close',
    loading: 'Loading…',
    providerReady: 'ready',
    providerPlanned: 'planned',
  },
  zh: {
    secretsTitle: '公司密钥',
    secretsDescription:
      '静态加密存储（AES-256-GCM）。明文永不离开内核：本页面只看到掩码台账。消费方必须经显式绑定才能读取，所有访问（包括被拒绝的）都会被审计。',
    createSecret: '新建密钥',
    name: '名称',
    value: '值',
    description: '描述',
    create: '创建',
    rotate: '轮换',
    rotateTitle: '轮换密钥',
    rotateHint: '存入新版本；旧版本保留在审计链中。',
    archive: '归档',
    restore: '恢复',
    del: '删除',
    deleteConfirm: '删除该密钥及其全部版本与绑定？审计记录会保留。',
    bindings: '绑定',
    bind: '绑定消费方',
    bindTitle: '授权一个消费方',
    bindHint: '密钥将以此环境变量落入消费方。required 绑定接入可调用性闸门：密钥缺失时该消费方无法接单。',
    targetType: '消费方类型',
    targetId: '消费方 ID',
    envVar: '环境变量名',
    required: '必需（接入可调用性闸门）',
    unbind: '解绑',
    accessLog: '访问审计',
    accessLogTitle: '访问审计记录',
    noEvents: '暂无访问事件。',
    noBindings: '尚无绑定——当前没有任何消费方能读取该密钥。',
    noSecrets: '暂无密钥。',
    archivedPill: '已归档',
    instanceTitle: '实例设置',
    instanceDescription: '单例实例配置，两个桶。值为 JSON。',
    bucket: '桶',
    key: '键',
    set: '设置',
    unset: '移除',
    emptyBucket: '（空）',
    cancel: '取消',
    close: '关闭',
    loading: '加载中…',
    providerReady: '可用',
    providerPlanned: '规划中',
  },
} as const;

export function SecretsSettings({ readJson, lang = 'en' }: { readJson: ReadJson; lang?: 'en' | 'zh' }) {
  const t = DICT[lang] ?? DICT.en;
  const [contract, setContract] = useState<SecretsContract | null>(null);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [instance, setInstance] = useState<Record<string, Record<string, unknown>>>({});
  const [bindingsBySecret, setBindingsBySecret] = useState<Record<string, SecretBinding[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<SecretSummary | null>(null);
  const [bindTarget, setBindTarget] = useState<SecretSummary | null>(null);
  const [logTarget, setLogTarget] = useState<SecretSummary | null>(null);
  const [logEvents, setLogEvents] = useState<AccessEvent[]>([]);

  const [draftName, setDraftName] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftTargetType, setDraftTargetType] = useState('agent_profile');
  const [draftTargetId, setDraftTargetId] = useState('');
  const [draftEnv, setDraftEnv] = useState('');
  const [draftRequired, setDraftRequired] = useState(true);
  const [bucketDraft, setBucketDraft] = useState('general');
  const [keyDraft, setKeyDraft] = useState('');
  const [valueDraft, setValueDraft] = useState('');

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setError(null);
      try {
        await work();
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : String(exc));
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const [contractPayload, listPayload, instancePayload] = await Promise.all([
      readJson('/api/secrets/contract'),
      readJson('/api/secrets'),
      readJson('/api/instance-settings'),
    ]);
    setContract(contractPayload as SecretsContract);
    setSecrets((listPayload as { secrets: SecretSummary[] }).secrets ?? []);
    setInstance({
      general: (instancePayload as any).general ?? {},
      experimental: (instancePayload as any).experimental ?? {},
    });
    setLoaded(true);
  }, [readJson]);

  useEffect(() => {
    void run(refresh);
  }, [run, refresh]);

  const loadBindings = useCallback(
    async (secret: SecretSummary) => {
      const payload = (await readJson(
        `/api/secrets/bindings?secret=${encodeURIComponent(secret.name)}&company=${encodeURIComponent(secret.company_profile_id)}`,
      )) as { bindings: SecretBinding[] };
      setBindingsBySecret((previous) => ({
        ...previous,
        [secret.secret_id]: (payload.bindings ?? []).filter((b) => b.secret_id === secret.secret_id),
      }));
    },
    [readJson],
  );

  const toggleBindings = (secret: SecretSummary) =>
    void run(async () => {
      if (expanded === secret.secret_id) {
        setExpanded(null);
        return;
      }
      await loadBindings(secret);
      setExpanded(secret.secret_id);
    });

  const openAccessLog = (secret: SecretSummary) =>
    void run(async () => {
      const payload = (await readJson(
        `/api/secrets/${encodeURIComponent(secret.name)}/access-log?company=${encodeURIComponent(secret.company_profile_id)}`,
      )) as { events: AccessEvent[] };
      setLogEvents(payload.events ?? []);
      setLogTarget(secret);
    });

  const submitCreate = () =>
    void run(async () => {
      await readJson('/api/secrets', {
        method: 'POST',
        body: JSON.stringify({ name: draftName, value: draftValue, description: draftDescription }),
      });
      setCreateOpen(false);
      setDraftName('');
      setDraftValue('');
      setDraftDescription('');
      await refresh();
    });

  const submitRotate = () =>
    void run(async () => {
      if (!rotateTarget) return;
      await readJson(`/api/secrets/${encodeURIComponent(rotateTarget.name)}/rotate`, {
        method: 'POST',
        body: JSON.stringify({ value: draftValue, company: rotateTarget.company_profile_id }),
      });
      setRotateTarget(null);
      setDraftValue('');
      await refresh();
    });

  const submitBind = () =>
    void run(async () => {
      if (!bindTarget) return;
      await readJson(`/api/secrets/${encodeURIComponent(bindTarget.name)}/bindings`, {
        method: 'POST',
        body: JSON.stringify({
          target_type: draftTargetType,
          target_id: draftTargetId,
          env: draftEnv,
          required: draftRequired,
          company: bindTarget.company_profile_id,
        }),
      });
      const secret = bindTarget;
      setBindTarget(null);
      setDraftTargetId('');
      setDraftEnv('');
      setDraftRequired(true);
      await loadBindings(secret);
    });

  const toggleArchive = (secret: SecretSummary) =>
    void run(async () => {
      await readJson(`/api/secrets/${encodeURIComponent(secret.name)}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: !secret.archived, company: secret.company_profile_id }),
      });
      await refresh();
    });

  const deleteSecret = (secret: SecretSummary) => {
    if (!window.confirm(t.deleteConfirm)) return;
    void run(async () => {
      await readJson(
        `/api/secrets/${encodeURIComponent(secret.name)}?company=${encodeURIComponent(secret.company_profile_id)}`,
        { method: 'DELETE' },
      );
      await refresh();
    });
  };

  const unbind = (secret: SecretSummary, binding: SecretBinding) =>
    void run(async () => {
      await readJson(`/api/secrets/bindings/${encodeURIComponent(binding.binding_id)}`, { method: 'DELETE' });
      await loadBindings(secret);
    });

  const submitInstanceSet = () =>
    void run(async () => {
      let parsed: unknown = valueDraft;
      try {
        parsed = JSON.parse(valueDraft);
      } catch {
        // bare strings are accepted as-is (CLI parity)
      }
      await readJson(`/api/instance-settings/${encodeURIComponent(bucketDraft)}`, {
        method: 'PATCH',
        body: JSON.stringify({ patch: { [keyDraft]: parsed } }),
      });
      setKeyDraft('');
      setValueDraft('');
      await refresh();
    });

  const unsetInstanceKey = (bucket: string, key: string) =>
    void run(async () => {
      await readJson(`/api/instance-settings/${encodeURIComponent(bucket)}`, {
        method: 'PATCH',
        body: JSON.stringify({ patch: { [key]: null } }),
      });
      await refresh();
    });

  const targetTypeOptions = useMemo(
    () => (contract?.binding_target_types ?? []).map((value) => ({ value, label: value })),
    [contract],
  );
  const buckets = contract?.instance_settings_buckets ?? ['general', 'experimental'];

  return (
    <div className="settings-panel secrets-settings" aria-label={t.secretsTitle}>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <article className="control-card">
        <div className="control-card-head">
          <KeyRound size={18} aria-hidden="true" />
          <strong>{t.secretsTitle}</strong>
          <span className="status-pill neutral">
            {(contract?.providers ?? [])
              .filter((p) => p.ready)
              .map((p) => p.label)
              .join(', ') || t.loading}
          </span>
        </div>
        <p>{t.secretsDescription}</p>
        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              setDraftValue('');
              setCreateOpen(true);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t.createSecret}
          </button>
        </div>
        {!loaded ? <p>{t.loading}</p> : null}
        {loaded && secrets.length === 0 ? <p>{t.noSecrets}</p> : null}
        <div className="timeline-list" aria-label={t.secretsTitle}>
          {secrets.map((secret) => (
            <article key={secret.secret_id} className="timeline-item complete">
              <div>
                <strong>{secret.name}</strong>
                <p>
                  v{secret.current_version} · {secret.provider}
                  {secret.description ? ` · ${secret.description}` : ''}
                </p>
                {expanded === secret.secret_id ? (
                  <div className="secret-bindings">
                    {(bindingsBySecret[secret.secret_id] ?? []).length === 0 ? (
                      <p>{t.noBindings}</p>
                    ) : (
                      (bindingsBySecret[secret.secret_id] ?? []).map((binding) => (
                        <p key={binding.binding_id}>
                          {binding.target_type}:{binding.target_id} ← {binding.config_path}
                          {binding.required ? ' · required' : ' · optional'}{' '}
                          <button type="button" className="ghost-button" onClick={() => unbind(secret, binding)}>
                            {t.unbind}
                          </button>
                        </p>
                      ))
                    )}
                    <button type="button" className="ghost-button" onClick={() => setBindTarget(secret)}>
                      <Link2 size={14} aria-hidden="true" />
                      {t.bind}
                    </button>
                  </div>
                ) : null}
                <span className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setDraftValue('');
                      setRotateTarget(secret);
                    }}
                  >
                    <RotateCw size={14} aria-hidden="true" />
                    {t.rotate}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => toggleBindings(secret)}>
                    <Link2 size={14} aria-hidden="true" />
                    {t.bindings}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => openAccessLog(secret)}>
                    <FileClock size={14} aria-hidden="true" />
                    {t.accessLog}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => toggleArchive(secret)}>
                    {secret.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                    {secret.archived ? t.restore : t.archive}
                  </button>
                  <button type="button" className="ghost-button danger" onClick={() => deleteSecret(secret)}>
                    <Trash2 size={14} aria-hidden="true" />
                    {t.del}
                  </button>
                </span>
              </div>
              <span className={`status-pill ${secret.archived ? 'warn' : 'good'}`}>
                {secret.archived ? t.archivedPill : `v${secret.current_version}`}
              </span>
            </article>
          ))}
        </div>
      </article>

      <article className="control-card">
        <div className="control-card-head">
          <KeyRound size={18} aria-hidden="true" />
          <strong>{t.instanceTitle}</strong>
        </div>
        <p>{t.instanceDescription}</p>
        {buckets.map((bucket) => (
          <div key={bucket} className="instance-bucket">
            <strong>[{bucket}]</strong>
            {Object.keys(instance[bucket] ?? {}).length === 0 ? (
              <p>{t.emptyBucket}</p>
            ) : (
              Object.entries(instance[bucket] ?? {}).map(([key, value]) => (
                <p key={key}>
                  <code>
                    {key}={JSON.stringify(value)}
                  </code>{' '}
                  <button type="button" className="ghost-button" onClick={() => unsetInstanceKey(bucket, key)}>
                    {t.unset}
                  </button>
                </p>
              ))
            )}
          </div>
        ))}
        <div className="inline-form">
          <label className="stacked-field">
            <span>{t.bucket}</span>
            <Dropdown
              ariaLabel={t.bucket}
              variant="field"
              value={bucketDraft}
              options={buckets.map((value) => ({ value, label: value }))}
              onChange={setBucketDraft}
            />
          </label>
          <label className="stacked-field">
            <span>{t.key}</span>
            <input value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} />
          </label>
          <label className="stacked-field">
            <span>{t.value}</span>
            <input value={valueDraft} onChange={(event) => setValueDraft(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" disabled={!keyDraft} onClick={submitInstanceSet}>
              {t.set}
            </button>
          </div>
        </div>
      </article>

      <DialogShell
        open={createOpen}
        titleId="secrets-create-title"
        title={t.createSecret}
        closeLabel={t.cancel}
        onClose={() => {
          setCreateOpen(false);
          setDraftValue('');
        }}
        dismissable
      >
        <div className="inline-form">
          <label className="stacked-field">
            <span>{t.name}</span>
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <label className="stacked-field">
            <span>{t.value}</span>
            <input type="password" autoComplete="off" value={draftValue} onChange={(event) => setDraftValue(event.target.value)} />
          </label>
          <label className="stacked-field">
            <span>{t.description}</span>
            <input value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" disabled={!draftName || !draftValue} onClick={submitCreate}>
              {t.create}
            </button>
          </div>
        </div>
      </DialogShell>

      <DialogShell
        open={rotateTarget !== null}
        titleId="secrets-rotate-title"
        title={`${t.rotateTitle}: ${rotateTarget?.name ?? ''}`}
        subtitle={t.rotateHint}
        closeLabel={t.cancel}
        onClose={() => {
          setRotateTarget(null);
          setDraftValue('');
        }}
        dismissable
      >
        <div className="inline-form">
          <label className="stacked-field">
            <span>{t.value}</span>
            <input type="password" autoComplete="off" value={draftValue} onChange={(event) => setDraftValue(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" disabled={!draftValue} onClick={submitRotate}>
              {t.rotate}
            </button>
          </div>
        </div>
      </DialogShell>

      <DialogShell
        open={bindTarget !== null}
        titleId="secrets-bind-title"
        title={`${t.bindTitle}: ${bindTarget?.name ?? ''}`}
        subtitle={t.bindHint}
        closeLabel={t.cancel}
        onClose={() => setBindTarget(null)}
        dismissable
      >
        <div className="inline-form">
          <label className="stacked-field">
            <span>{t.targetType}</span>
            <Dropdown
              ariaLabel={t.targetType}
              variant="field"
              value={draftTargetType}
              options={targetTypeOptions}
              onChange={setDraftTargetType}
            />
          </label>
          <label className="stacked-field">
            <span>{t.targetId}</span>
            <input value={draftTargetId} onChange={(event) => setDraftTargetId(event.target.value)} />
          </label>
          <label className="stacked-field">
            <span>{t.envVar}</span>
            <input value={draftEnv} onChange={(event) => setDraftEnv(event.target.value)} />
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={draftRequired} onChange={(event) => setDraftRequired(event.target.checked)} />
            <span>{t.required}</span>
          </label>
          <div className="button-row">
            <button type="button" disabled={!draftTargetId || !draftEnv} onClick={submitBind}>
              {t.bind}
            </button>
          </div>
        </div>
      </DialogShell>

      <DialogShell
        open={logTarget !== null}
        titleId="secrets-log-title"
        title={`${t.accessLogTitle}: ${logTarget?.name ?? ''}`}
        closeLabel={t.close}
        onClose={() => setLogTarget(null)}
        dismissable
        variant="wide"
      >
        {logEvents.length === 0 ? (
          <p>{t.noEvents}</p>
        ) : (
          <div className="timeline-list">
            {logEvents.map((event) => (
              <article key={event.event_id} className="timeline-item complete">
                <div>
                  <strong>{event.action}</strong>
                  <p>
                    {new Date(event.occurred_at * 1000).toLocaleString()} · {event.actor}
                    {event.target_type ? ` · ${event.target_type}:${event.target_id}` : ''}
                    {event.detail ? ` · ${event.detail}` : ''}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </DialogShell>
    </div>
  );
}
