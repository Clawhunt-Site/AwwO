import { useEffect, useState, type ReactNode } from "react";
import { api, saasErrorMessage, type Identity } from "./api";
import { PreferenceControls, useSaaSPreferences } from "./preferences";
import "./personal-account.css";

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
const engineName = (id: string) => (id === "pi" ? "Pi" : "OpenAI Agents JS");
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
        <PreferenceControls />
      </header>
      <section className="saas-page-intro">
        <h1>{title}</h1>
        <p>{intro}</p>
      </section>
      {children}
    </main>
  );
}

/** Identity-gated; neither a browser storage flag nor an admin's provider key completes onboarding. */
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
    identity.personalCredentialsRequired === true || section === "engines";
  const [catalog, setCatalog] = useState<Connections | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!needed) return;
    const controller = new AbortController();
    api<Connections>("/auth/connections", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [identity.user.id, needed]);
  if (section === "security") return <AccountSecurity />;
  if (!needed) return <>{children}</>;
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
  if (catalog.items.length && section !== "engines") return <>{children}</>;
  return (
    <ConnectionSettings
      catalog={catalog}
      onChange={setCatalog}
      onboarding={catalog.items.length === 0}
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
      <nav className="saas-personal-nav">
        <a href={accountURL("security")}>{t("账号安全", "Account security")}</a>
        <button
          onClick={async () => {
            await api("/auth/logout", { method: "POST" });
            location.reload();
          }}
        >
          {t("退出登录", "Sign out")}
        </button>
        {!onboarding && (
          <a href={home()}>{t("返回工作区", "Back to workspace")}</a>
        )}
      </nav>
      <div className="saas-connection-grid">
        <form
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
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              minLength={8}
              maxLength={4096}
              value={key}
              disabled={busy}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
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
          <button className="saas-primary" disabled={busy || !provider || !key}>
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
      {catalog.items.length > 0 && (
        <section className="saas-card saas-connection-list">
          <h2>{t("已连接的服务", "Connected providers")}</h2>
          {catalog.items.map((c) => (
            <article key={c.id}>
              <div>
                <strong>{c.name}</strong>
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
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api("/auth/connections/" + encodeURIComponent(c.id), {
                      method: "DELETE",
                    });
                    await refresh();
                  } catch (cause) {
                    setError(cause);
                  } finally {
                    setBusy(false);
                  }
                }}
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
          <a className="saas-primary saas-buy-link" href={home()}>
            {t("进入工作区", "Open workspace")}
          </a>
        </section>
      )}
    </AccountLayout>
  );
}

type AuthSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};
export function AccountSecurity() {
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
        <a href={accountURL("engines")}>{t("我的执行引擎", "My engines")}</a>
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
              "输入注册邮箱，我们会发送限时重设链接。",
              "Enter your email to request a time-limited reset link.",
            )
      }
    >
      <form
        className="saas-card saas-recovery"
        onSubmit={async (e) => {
          e.preventDefault();
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
                disabled={busy}
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
                disabled={busy}
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
          <button className="saas-primary" disabled={busy}>
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
