import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, saasErrorMessage, type Identity } from "./api";
import { PreferenceControls, useSaaSPreferences } from "./preferences";
import "./personal-account.css";
import { GuideLauncher, MainSiteLink } from "./SaaSOnboarding";
import { SecretInput } from "./SecretInput";

type Provider = { id: string; name: string; runtimes: string[] };
type Connection = {
  id: string;
  name: string;
  provider: string;
  runtime: string;
  models: string[];
  hasKey: boolean;
};
type Connections = {
  items: Connection[];
  providers: Provider[];
  required: boolean;
  purchaseURL: string;
};
const connectionUsable = (connection: Connection, catalog: Connections) =>
  connection.hasKey &&
  connection.models.length > 0 &&
  catalog.providers.some(
    (provider) =>
      provider.id === connection.provider &&
      provider.runtimes.includes(connection.runtime),
  );
const engineName = (id: string) => (id === "pi" ? "Pi" : "OpenAI Agents");
const home = () => {
  const query = new URLSearchParams(location.search);
  query.delete("account");
  query.delete("reset");
  return "/" + (query.size ? "?" + query : "");
};
export function accountURL(section: string) {
  const query = new URLSearchParams(location.search);
  query.set("account", section);
  return "/?" + query;
}

function AccountLayout({
  children,
  title,
  intro,
}: {
  children: ReactNode;
  title: string;
  intro: string;
}) {
  return (
    <main className="saas-dashboard saas-personal">
      <header>
        <a href="/" className="saas-logo">
          AwwO
        </a>
        <div className="saas-account-header-actions"><PreferenceControls /><GuideLauncher /><MainSiteLink /></div>
      </header>
      <section className="saas-page-intro">
        <h1>{title}</h1>
        <p>{intro}</p>
      </section>
      {children}
    </main>
  );
}

/** A personal key is required for execution, but never for viewing an existing workspace. */
export function PersonalEngineGate({
  identity,
  children,
}: {
  identity: Identity;
  children: ReactNode;
}) {
  const { t, locale } = useSaaSPreferences();
  const section = new URLSearchParams(location.search).get("account");
  const needed =
    identity.personalCredentialsRequired === true;
  const [catalog, setCatalog] = useState<Connections | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!needed) return;
    const controller = new AbortController();
    setCatalog(null);
    setError(null);
    api<Connections>("/auth/connections", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [identity.user.id, needed, revision]);
  if (section === "security") return <AccountSecurity personalCredentialsRequired={needed} />;
  if (section === "engines" && !needed) return <AccountLayout title={t("模型服务", "Model service")} intro={t("AwwO 已通过 LLM Gate 提供模型，无需填写个人 API Key。", "AwwO provides models through LLM Gate. No personal API key is needed.")}><a href={home()}>{t("返回工作区", "Back to workspace")}</a></AccountLayout>;
  if (!needed) return <>{children}</>;
  const hasUsableConnection = catalog?.items.some((item) =>
    connectionUsable(item, catalog),
  ) ?? false;
  if (section !== "engines") {
    const needsEngine = Boolean(catalog && !hasUsableConnection);
    const canvasPage = new URLSearchParams(location.search).has("canvas");
    const content = <>
      {(Boolean(error) || needsEngine) && (
        <div className="saas-runtime-note saas-personal-notice" role={error ? "alert" : "status"}>
          <strong>{error
            ? t("无法检查执行引擎连接", "Could not check engine connections")
            : t("尚未连接执行引擎", "No execution engine connected")}</strong>
          <span>{error
            ? t("工作区和历史仍可使用。", "Your workspaces and history remain available.") + " " + saasErrorMessage(error, locale)
            : canvasPage
              ? t("画布仍可编辑；运行前请连接 API Key。", "You can still edit this canvas. Connect an API key before running it.")
              : t("现有工作区、画布和历史仍可浏览及编辑；运行任务前请连接自己的 API Key。", "You can still browse and edit your workspaces, canvases and history. Connect your own API key before running tasks.")}</span>
          <a href={accountURL("engines")}>{t("连接执行引擎", "Connect an engine")}</a>
          {Boolean(error) && <button type="button" onClick={() => setRevision(value => value + 1)}>{t("重新检查", "Retry check")}</button>}
        </div>
      )}
      {children}
    </>;
    return canvasPage
      ? <div className={`saas-personal-gated-canvas${needsEngine ? " saas-personal-gated-canvas--needs-engine" : ""}`}>{content}</div>
      : content;
  }
  if (error)
    return (
      <AccountLayout
        title={t("连接执行引擎", "Connect an engine")}
        intro={t("使用你自己的模型凭证。", "Use your own model credentials.")}
      >
        <p role="alert">{saasErrorMessage(error, locale)}</p>
        <button onClick={() => location.reload()}>
          {t("重新连接", "Retry")}
        </button>
        <a href={home()}>{t("返回工作区", "Back to workspace")}</a>
      </AccountLayout>
    );
  if (!catalog)
    return (
      <AccountLayout
        title={t("连接执行引擎", "Connect an engine")}
        intro={t("正在读取个人配置…", "Loading your settings…")}
      >
        <p role="status">{t("请稍候…", "Please wait…")}</p>
      </AccountLayout>
    );
  return (
    <ConnectionSettings
      catalog={catalog}
      onChange={setCatalog}
      onboarding={!hasUsableConnection}
    />
  );
}

export function ConnectionSettings({
  catalog,
  onChange,
  onboarding,
}: {
  catalog: Connections;
  onChange: (c: Connections) => void;
  onboarding: boolean;
}) {
  const { t, locale } = useSaaSPreferences();
  const [providerID, setProviderID] = useState(catalog.providers[0]?.id || "");
  const provider = catalog.providers.find((item) => item.id === providerID);
  const [runtime, setRuntime] = useState(provider?.runtimes[0] || "");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<Connection | null>(null);
  const providerForm = useRef<HTMLFormElement>(null);
  const removalTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (removing) return;
    const trigger = removalTrigger.current;
    if (!trigger) return;
    (trigger.isConnected ? trigger : providerForm.current?.querySelector('select'))?.focus();
    removalTrigger.current = null;
  }, [removing]);
  const refresh = async () =>
    onChange(await api<Connections>("/auth/connections"));
  return (
    <AccountLayout
      title={
        onboarding
          ? t("先连接你的执行引擎", "Connect your first engine")
          : t("我的执行引擎", "My engines")
      }
      intro={t(
        "选择模型服务，填写自己的 API Key。每次任务使用发起者的个人凭证。",
        "Choose a provider and add your API key. Each task uses the credentials of the person who starts it.",
      )}
    >
      {onboarding && <ol className="saas-onboarding-steps" aria-label={t('开始使用', 'Getting started')}>
        <li>{t('1 · 账号已创建', '1 · Account created')}</li>
        <li aria-current="step">{t('2 · 连接模型服务', '2 · Connect a provider')}</li>
        <li>{t('3 · 创建画布', '3 · Create a canvas')}</li>
      </ol>}
      <nav className="saas-personal-nav">
        <a href={accountURL("security")}>{t("账号安全", "Account security")}</a>
        <button
          onClick={async () => {
            try { await api("/auth/logout", { method: "POST" }); location.reload(); }
            catch (cause) { setError(cause); }
          }}
        >
          {t("退出登录", "Sign out")}
        </button>
        <a href={home()}>{t("返回工作区", "Back to workspace")}</a>
      </nav>
      <div className="saas-connection-grid">
        <form
          ref={providerForm}
          data-onboarding="engine-setup"
          className="saas-card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(null);
            setNotice("");
            try {
              await api("/auth/connections", {
                method: "POST",
                body: JSON.stringify({
                  provider: providerID,
                  runtime,
                  apiKey: key,
                  name,
                }),
              });
              setKey("");
              await refresh();
              setNotice(
                t(
                  "凭证已加密保存，模型目录已验证。",
                  "Credentials encrypted and model catalog verified.",
                ),
              );
            } catch (cause) {
              setError(cause);
            } finally {
              setKey("");
              setBusy(false);
            }
          }}
        >
          <span className="saas-eyebrow">
            {t("个人连接", "PERSONAL CONNECTION")}
          </span>
          <h2>{t("添加模型服务", "Add a model provider")}</h2>
          <label>
            {t("模型服务", "Model provider")}
            <select
              value={providerID}
              disabled={busy}
              onChange={(e) => {
                setProviderID(e.target.value);
                setError(null); setNotice("");
                setRuntime(
                  catalog.providers.find((p) => p.id === e.target.value)
                    ?.runtimes[0] || "",
                );
                setKey("");
              }}
            >
              {catalog.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("执行引擎", "Execution engine")}
            <select
              value={runtime}
              disabled={busy}
              onChange={(e) => setRuntime(e.target.value)}
            >
              {provider?.runtimes.map((id) => (
                <option key={id} value={id}>
                  {engineName(id)}
                </option>
              ))}
            </select>
          </label>
          <p className="saas-field-hint">{runtime === 'pi'
            ? t('Pi：通过所选服务商运行 Agent，支持多种模型。', 'Pi runs Agents through your selected provider and supports multiple models.')
            : t('OpenAI Agents：通过兼容接口运行 Agent，也可使用 LLM Gate 的模型。不确定时保留默认选择即可。', 'OpenAI Agents runs Agents through a compatible API, including LLM Gate models. Keep the default if you are unsure.')}</p>
          <label>
            {t("连接名称（可选）", "Connection name (optional)")}
            <input
              value={name}
              maxLength={80}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("例如：我的工作账号", "For example: Work account")}
            />
          </label>
          <SecretInput key={providerID} label="API Key" name="provider-api-key" data-onboarding="provider-key"
            autoComplete="new-password" spellCheck={false} required minLength={8} maxLength={4096}
            value={key} disabled={busy} onChange={(e) => setKey(e.target.value)}
            aria-describedby="provider-key-help" />
          <p id="provider-key-help" className="saas-field-hint">{t(
            `请填写 ${provider?.name || ''} 的 API Key，不是 AwwO 登录密码。`,
            `Use an API key from ${provider?.name || 'your provider'}, not your AwwO password.`)}</p>
          <small>
            {t(
              "密钥加密保存在服务端，不写入画布或浏览器存储。验证会读取服务商的模型目录。",
              "Your key is encrypted on the server, never stored in canvases or browser storage. Verification reads the provider’s model catalog.",
            )}
          </small>
          {error !== null && (
            <p role="alert" className="saas-error">
              {saasErrorMessage(error, locale)}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <button data-onboarding="provider-verify" className="saas-primary" disabled={busy || !provider || !key}>
            {busy
              ? t("正在验证…", "Verifying…")
              : t("验证并保存", "Verify and save")}
          </button>
        </form>
        <aside className="saas-card saas-gate-card">
          <span className="saas-eyebrow">LLM GATE</span>
          <h2>{t("使用我们的模型服务", "Use our model service")}</h2>
          <p>
            {t(
              "前往 LLM Gate 购买额度并创建自己的调用凭证，回来选择 LLM Gate，填入 API Key 即可。",
              "Purchase credits and create your own credential in LLM Gate, then choose LLM Gate here and enter your API key.",
            )}
          </p>
          <a
            data-onboarding="gate-purchase"
            className="saas-primary saas-buy-link"
            href={catalog.purchaseURL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("前往 LLM Gate", "Open LLM Gate")} ↗
          </a>
          <p className="saas-muted">
            {t(
              "AwwO 不代扣款，也不会替你购买。可用模型、额度和费用以你的服务商账号为准。",
              "AwwO does not make purchases on your behalf. Models, credit and charges depend on your provider account.",
            )}
          </p>
        </aside>
      </div>
      {removing && <RemoveConnectionDialog connection={removing} onClose={() => setRemoving(null)}
        onDeleted={() => onChange({ ...catalog, items: catalog.items.filter(item => item.id !== removing.id) })}
        onRemoved={async () => { await refresh(); setRemoving(null); }} />}
      {catalog.items.length > 0 && (
        <section className="saas-card saas-connection-list">
          <h2>{t("已连接的服务", "Connected providers")}</h2>
          {catalog.items.map((c) => (
            <article key={c.id}>
              <div>
                <strong>{c.name}</strong>
                {!connectionUsable(c, catalog) && (
                  <p>
                    {t(
                      "当前无法用于新任务。请添加可用的模型服务连接。",
                      "Unavailable for new tasks. Add an allowed model provider connection.",
                    )}
                  </p>
                )}
                <p>
                  {engineName(c.runtime)} · {c.models.length}{" "}
                  {t("个模型", "models")} · API Key {t("已保存", "saved")}
                </p>
                <p>
                  {c.provider} / {c.id.slice(-6)}
                </p>
                <details>
                  <summary>{t("查看模型", "View models")}</summary>
                  <ul>
                    {c.models.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </details>
              </div>
              <button
                disabled={busy}
                onClick={event => { removalTrigger.current = event.currentTarget; setRemoving(c); }}
              >
                {t("移除连接", "Remove connection")}
              </button>
            </article>
          ))}
          <p>
            {t(
              "移除后，后续调用停止使用该密钥。更换密钥请添加新连接，再移除旧连接。已开始的调用可能继续完成。",
              "Removing a connection prevents new calls. To rotate a key, add a replacement and remove the old connection. Calls already in progress may finish.",
            )}
          </p>
          {!onboarding && (
            <a className="saas-primary saas-buy-link" href={home()}>
              {t("进入工作区", "Open workspace")}
            </a>
          )}
        </section>
      )}
    </AccountLayout>
  );
}

function RemoveConnectionDialog({ connection, onClose, onDeleted, onRemoved }: {
  connection: Connection; onClose: () => void; onDeleted: () => void; onRemoved: () => Promise<void>;
}) {
  const { t, locale } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="saas-native-dialog" aria-labelledby="remove-connection-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError(null);
      try {
        if (!removed) {
          await api('/auth/connections/' + encodeURIComponent(connection.id), { method: 'DELETE' });
          setRemoved(true);
          onDeleted();
        }
        await onRemoved();
      } catch (cause) { setError(cause); } finally { setBusy(false); }
    }}>
      <h2 id="remove-connection-title">{t('移除模型连接？', 'Remove model connection?')}</h2>
      <p>{t(`将移除“${connection.name}”。后续任务无法再使用此连接；已开始的调用可能继续完成。重新使用需要再次填写 API Key。`,
        `Remove “${connection.name}”? New tasks cannot use this connection. Calls in progress may finish. Reconnecting requires the API key again.`)}</p>
      {removed && <p role="status">{t('连接已移除，正在更新列表。若刷新失败，请重试刷新。', 'Connection removed. Refresh the list if it could not be updated.')}</p>}
      {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
      <div className="saas-draft-actions">
        <button type="button" autoFocus disabled={busy} onClick={onClose}>{removed ? t('关闭', 'Close') : t('取消', 'Cancel')}</button>
        <button className="saas-danger-button" disabled={busy}>{busy ? t('请稍候…', 'Please wait…') : removed ? t('刷新列表', 'Refresh list') : t('确认移除', 'Remove connection')}</button>
      </div>
    </form>
  </dialog>;
}

type AuthSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};
export function AccountSecurity({ personalCredentialsRequired = true }: { personalCredentialsRequired?: boolean } = {}) {
  const { t, locale } = useSaaSPreferences();
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    api<{ items: AuthSession[] }>("/auth/sessions").then((v) =>
      setSessions(v.items),
    );
  useEffect(() => {
    void refresh().catch(setError);
  }, []);
  return (
    <AccountLayout
      title={t("账号安全", "Account security")}
      intro={t(
        "管理密码和已登录的会话。",
        "Manage your password and signed-in sessions.",
      )}
    >
      <nav className="saas-personal-nav">
        {personalCredentialsRequired && <a href={accountURL("engines")}>{t("我的执行引擎", "My engines")}</a>}
        <a href={home()}>{t("返回工作区", "Back to workspace")}</a>
      </nav>
      {error !== null && (
        <p role="alert" className="saas-error">
          {saasErrorMessage(error, locale)}
        </p>
      )}
      <div className="saas-connection-grid">
        <form
          className="saas-card"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.currentTarget));
            if (data.newPassword !== data.confirmPassword) {
              setError(
                new Error(
                  t("两次新密码不一致。", "The new passwords do not match."),
                ),
              );
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await api("/auth/password", {
                method: "POST",
                body: JSON.stringify({
                  currentPassword: data.currentPassword,
                  newPassword: data.newPassword,
                }),
              });
              location.assign("/");
            } catch (cause) {
              setError(cause);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{t("修改密码", "Change password")}</h2>
          <label>
            {t("当前密码", "Current password")}
            <input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </label>
          <label>
            {t("新密码", "New password")}
            <input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={1024}
              disabled={busy}
            />
          </label>
          <label>
            {t("确认新密码", "Confirm new password")}
            <input
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={1024}
              disabled={busy}
            />
          </label>
          <small>
            {t(
              "至少 12 位。修改后所有设备都需要重新登录。",
              "At least 12 characters. All devices must sign in again after a change.",
            )}
          </small>
          <button className="saas-primary" disabled={busy}>
            {t("修改并重新登录", "Change and sign in again")}
          </button>
        </form>
        <section className="saas-card">
          <h2>{t("已登录会话", "Signed-in sessions")}</h2>
          {sessions.map((s) => (
            <article className="saas-session" key={s.id}>
              <div>
                <strong>
                  {s.current
                    ? t("当前设备", "Current session")
                    : t("其他会话", "Other session")}
                </strong>
                <p>{new Date(s.createdAt).toLocaleString()}</p>
              </div>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/auth/sessions/" + s.id, { method: "DELETE" });
                    if (s.current) location.assign("/");
                    else await refresh();
                  } catch (cause) {
                    setError(cause);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("退出此会话", "Sign out")}
              </button>
            </article>
          ))}
        </section>
      </div>
    </AccountLayout>
  );
}

export function PasswordRecovery({
  token,
  onBack,
}: {
  token?: string;
  onBack: () => void;
}) {
  const { t, locale } = useSaaSPreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [recovery, setRecovery] = useState<'loading' | 'available' | 'unavailable' | 'error'>(token ? 'available' : 'loading');
  const [optionsRevision, setOptionsRevision] = useState(0);
  useEffect(() => {
    if (token) return;
    const controller = new AbortController(); setRecovery('loading');
    api<{ passwordRecovery: boolean }>('/auth/options', { signal: controller.signal })
      .then(options => { if (!controller.signal.aborted) setRecovery(options.passwordRecovery ? 'available' : 'unavailable'); })
      .catch(() => { if (!controller.signal.aborted) setRecovery('error'); });
    return () => controller.abort();
  }, [token, optionsRevision]);
  return (
    <AccountLayout
      title={
        token
          ? t("重设密码", "Reset password")
          : t("找回密码", "Recover your account")
      }
      intro={
        token
          ? t("设置新的登录密码。", "Set a new sign-in password.")
          : t(
              "使用注册邮箱找回密码。邮件服务可用时会发送限时重设链接。",
              "Enter your email to request a time-limited reset link.",
            )
      }
    >
      <form
        className="saas-card saas-recovery"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || recovery !== 'available') return;
          setBusy(true);
          setError(null);
          const form = e.currentTarget;
          const data = Object.fromEntries(new FormData(form));
          try {
            await api(
              token ? "/auth/reset-password" : "/auth/forgot-password",
              {
                method: "POST",
                body: JSON.stringify(
                  token
                    ? { token, password: data.password }
                    : { email: data.email },
                ),
              },
            );
            form.reset();
            setDone(true);
          } catch (cause) {
            setError(cause);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!token && recovery !== 'available' && <p role={recovery === 'error' ? 'alert' : 'status'}>{
          recovery === 'loading' ? t('正在检查邮件服务…', 'Checking email recovery…') : recovery === 'unavailable'
            ? t('邮件找回服务尚未配置，请联系管理员。当前无法发送重设邮件。', 'Email recovery is not configured. Contact your administrator; reset emails cannot be sent yet.')
            : t('无法检查邮件服务，请重试。', 'Could not check email recovery. Try again.')}</p>}
        {recovery === 'error' && <button type="button" onClick={() => setOptionsRevision(value => value + 1)}>{t('重试', 'Retry')}</button>}
        {!done &&
          (token ? (
            <label>
              {t("新密码", "New password")}
              <input
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
                disabled={busy || recovery !== 'available'}
              />
            </label>
          ) : (
            <label>
              {t("邮箱", "Email")}
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                disabled={busy || recovery !== 'available'}
              />
            </label>
          ))}
        {error !== null && (
          <p role="alert" className="saas-error">
            {saasErrorMessage(error, locale)}
          </p>
        )}
        {done ? (
          <p role="status">
            {token
              ? t(
                  "密码已更新，请重新登录。",
                  "Password updated. Sign in again.",
                )
              : t(
                  "如果此邮箱已注册，重设链接会发送到邮箱。请检查收件箱和垃圾邮件。",
                  "If this email is registered, a reset link will be sent. Check your inbox and spam folder.",
                )}
          </p>
        ) : (
          <button className="saas-primary" disabled={busy || recovery !== 'available'}>
            {busy
              ? t("请稍候…", "Please wait…")
              : token
                ? t("更新密码", "Update password")
                : t("发送重设链接", "Send reset link")}
          </button>
        )}
        <button type="button" onClick={onBack}>
          {t("返回登录", "Back to sign in")}
        </button>
      </form>
    </AccountLayout>
  );
}
