import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe2,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import { request, type Data, type Session } from "./api";
import { Button, ErrorBox, useLoad } from "./ui";
import Brand from "./Brand";
import ThemeToggle from "./ThemeToggle";

export default function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const config = useLoad(() => request("/config"));
  const [homeserver, setHomeserver] = useState(""),
    [discovery, setDiscovery] = useState<Data | null>(null),
    [checking, setChecking] = useState(false),
    [retry, setRetry] = useState(0);
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [token, setToken] = useState(""),
    [passwordMode, setPasswordMode] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  useEffect(() => {
    if (config.data) setHomeserver(config.data.homeserver || "");
  }, [config.data]);

  useEffect(() => {
    try {
      localStorage.removeItem("tuwunel-admin.pinned-server");
    } catch {}
    const reason = new URLSearchParams(location.search).get("auth_error");
    if (reason) {
      setError(
        reason === "not_admin"
          ? "认证成功，但此账号没有服务器管理员权限。"
          : reason === "expired"
            ? "认证已取消、超时或浏览器状态不匹配，请重新发起登录。"
            : "认证未能完成，请重试并检查服务器的客户端注册配置。",
      );
      history.replaceState(null, "", location.pathname + location.hash);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setDiscovery(null);
    setPassword("");
    setToken("");
    setPasswordMode(false);
    if (!config.data || !homeserver.trim()) {
      setChecking(false);
      return;
    }
    try {
      new URL(homeserver.trim());
    } catch {
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = setTimeout(
      () =>
        request("/auth/discover", "POST", { homeserver: homeserver.trim() })
          .then((data) => {
            if (active) {
              setDiscovery(data);
              setPasswordMode(!data.oauth && !data.sso && Boolean(data.password));
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setChecking(false);
          }),
      config.data.locked ? 0 : 500,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [homeserver, config.data, retry]);

  const isOidc = Boolean(discovery?.oauth);
  const isSso = Boolean(!isOidc && discovery?.sso);
  const allowPassword = Boolean(!isOidc && discovery?.password);

  const redirect = async () => {
    if (!discovery) return;
    setBusy(true);
    setError("");
    try {
      const result = await request("/auth/start", "POST", {
        homeserver: discovery.homeserver,
        kind: isOidc ? "oauth" : "sso",
      });
      location.assign(result.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const login = async (mode: "password" | "token") => {
    if (!discovery) return;
    setBusy(true);
    setError("");
    try {
      const session = await request("/login", "POST", {
        homeserver: discovery.homeserver,
        ...(mode === "password"
          ? { username, password }
          : { accessToken: token }),
      });
      setPassword("");
      setToken("");
      onLogin(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const authLabel = discovery
    ? isOidc
      ? discovery.nativeOidc
        ? "原生 OIDC 认证"
        : "OIDC / OAuth 认证"
      : isSso
        ? "单点登录 SSO"
        : allowPassword
          ? "账号密码登录"
          : "令牌登录"
    : "";

  return (
    <div className="access-page">
      <div className="access-ambient" aria-hidden="true" />
      <header className="access-header">
        <Brand />
        <div className="access-header-actions">
          <ThemeToggle />
          <a
            className="doc-pill"
            href="https://matrix-construct.github.io/tuwunel/"
            target="_blank"
            rel="noreferrer"
          >
            官方文档
            <ExternalLink size={13} />
          </a>
        </div>
      </header>

      <main className="access-layout">
        <section className="access-intro">
          <span className="access-kicker">
            <span className="dot" />
            Tuwunel Matrix Control Center
          </span>
          <h1>
            澄澈有序，
            <br />
            <em>掌控每一处连接。</em>
          </h1>
          <p>
            面向 Tuwunel 的现代管理工作台。成员、房间、媒体生命周期与服务器观测，
            以清晰克制的秩序呈现。
          </p>

          <div className="access-showcase" aria-hidden="true">
            <div className="showcase-main">
              <span className="showcase-icon">
                <Server size={20} />
              </span>
              <div>
                <strong>Matrix Homeserver</strong>
                <small>实时探测认证能力 · 服务端安全托管会话</small>
              </div>
              <span className="showcase-live" />
            </div>
            <div className="showcase-tiles">
              <div>
                <Users size={17} />
                <span>成员与桥接</span>
              </div>
              <div>
                <LayoutGrid size={17} />
                <span>房间治理</span>
              </div>
              <div>
                <HardDrive size={17} />
                <span>媒体与存储</span>
              </div>
            </div>
          </div>

          <div className="access-trust">
            <ShieldCheck size={17} />
            <span>
              使用服务器原生身份认证，登录凭据仅保存在受保护的服务端内存中。
            </span>
          </div>
        </section>

        <section className="access-card" aria-labelledby="login-heading">
          <div className="access-card-heading">
            <h2 id="login-heading">登录管理中心</h2>
            <p>自动识别目标服务器的认证方式，并校验管理员身份。</p>
          </div>

          <div className="connection-block">
            {config.data?.locked ? (
              <div className="fixed-server">
                <span className="fixed-server-icon">
                  <Lock size={16} />
                </span>
                <div>
                  <small>已锁定的服务器地址</small>
                  <strong>{homeserver}</strong>
                </div>
                <span className="fixed-tag">固定部署</span>
              </div>
            ) : (
              <label className="field">
                <span>Matrix 服务器地址</span>
                <div className="connection-input">
                  <Globe2 size={17} />
                  <input
                    aria-label="Matrix 服务器地址"
                    type="url"
                    value={homeserver}
                    placeholder="https://matrix.example.com"
                    autoComplete="url"
                    list="allowed-servers"
                    disabled={busy}
                    onChange={(e) => {
                      setHomeserver(e.target.value);
                      setError("");
                    }}
                  />
                </div>
                <datalist id="allowed-servers">
                  {config.data?.allowedHomeservers?.map((s: string) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </label>
            )}

            <div
              className={`connection-state ${discovery ? "ready" : ""}`}
              role="status"
            >
              {checking ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  <span>正在检测服务器认证能力…</span>
                </>
              ) : discovery ? (
                <>
                  <CheckCircle2 size={14} />
                  <span>已连接</span>
                  <span className="state-pill">{authLabel}</span>
                </>
              ) : (
                <>
                  <span className="dot muted-dot" />
                  <span>等待输入有效的服务器地址</span>
                </>
              )}
              <button
                type="button"
                className="state-refresh"
                aria-label="重新检测服务器"
                title="重新检测服务器"
                disabled={checking || busy || !homeserver}
                onClick={() => {
                  setError("");
                  setRetry((v) => v + 1);
                }}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>

          <ErrorBox error={error || config.error} />

          {discovery && (
            <div className="authentication-area">
              {isOidc ? (
                <>
                  <div className="auth-explanation">
                    <span className="auth-icon">
                      <ShieldCheck size={24} />
                    </span>
                    <h3>
                      {discovery.nativeOidc
                        ? "使用原生 OIDC 认证登录"
                        : "使用 OIDC 认证登录"}
                    </h3>
                    <p>
                      当前服务器已启用 OIDC 统一认证。
                      <br />
                      点击下方按钮前往认证页，完成后自动返回控制台。
                    </p>
                    {discovery.issuer && (
                      <code className="issuer-pill">{discovery.issuer}</code>
                    )}
                  </div>
                  <Button
                    kind="primary auth-submit"
                    disabled={busy || checking}
                    onClick={redirect}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <>
                        前往 OIDC 认证登录
                        <ArrowRight size={17} />
                      </>
                    )}
                  </Button>
                </>
              ) : isSso && !passwordMode ? (
                <>
                  <div className="auth-explanation">
                    <span className="auth-icon">
                      <ShieldCheck size={24} />
                    </span>
                    <h3>通过服务器单点登录</h3>
                    <p>
                      即将前往服务器的 SSO 认证页面。
                      <br />
                      完成验证后，自动返回管理中心。
                    </p>
                    {discovery.providers?.length > 0 && (
                      <div className="provider-names">
                        {discovery.providers.map((p: Data) => (
                          <span key={p.id}>{p.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    kind="primary auth-submit"
                    disabled={busy || checking}
                    onClick={redirect}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <>
                        前往认证登录
                        <ArrowRight size={17} />
                      </>
                    )}
                  </Button>
                  {allowPassword && (
                    <button
                      type="button"
                      className="method-switch"
                      onClick={() => setPasswordMode(true)}
                      disabled={busy}
                    >
                      使用账号密码登录
                    </button>
                  )}
                </>
              ) : allowPassword ? (
                <form
                  className="auth-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    login("password");
                  }}
                >
                  <label className="field">
                    <span>Matrix ID / 用户名</span>
                    <input
                      autoFocus={Boolean(config.data?.locked)}
                      required
                      value={username}
                      disabled={busy}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="@admin:example.com"
                      autoComplete="username"
                    />
                  </label>
                  <label className="field">
                    <span>密码</span>
                    <input
                      required
                      type="password"
                      value={password}
                      disabled={busy}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="输入管理员密码"
                      autoComplete="current-password"
                    />
                  </label>
                  <Button
                    kind="primary auth-submit"
                    type="submit"
                    disabled={busy || checking}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <>
                        登录管理中心
                        <ArrowRight size={17} />
                      </>
                    )}
                  </Button>
                  {isSso && (
                    <button
                      type="button"
                      className="method-switch"
                      onClick={() => setPasswordMode(false)}
                      disabled={busy}
                    >
                      返回单点登录
                    </button>
                  )}
                </form>
              ) : (
                <p className="notice">
                  服务器未提供可用的网页登录方式，可使用已有管理员令牌登录或检查认证配置。
                </p>
              )}

              {discovery.warning && (
                <p className="auth-warning">{discovery.warning}</p>
              )}

              {!isOidc && (
                <details className="token-alternative">
                  <summary>
                    <KeyRound size={14} />
                    使用已有管理员令牌
                  </summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      login("token");
                    }}
                  >
                    <label className="field">
                      <span>Access Token</span>
                      <input
                        required
                        type="password"
                        value={token}
                        disabled={busy}
                        autoComplete="off"
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="粘贴管理员访问令牌"
                      />
                    </label>
                    <Button type="submit" disabled={busy || checking}>
                      验证并登录
                      <ArrowRight size={14} />
                    </Button>
                  </form>
                </details>
              )}
            </div>
          )}

          {!discovery && !checking && !error && (
            <div className="await-connection">
              <span className="await-icon">
                <Globe2 size={24} />
              </span>
              <p>
                {config.loading
                  ? "正在读取部署配置…"
                  : "填写完整的 Matrix 服务器地址后，登录入口将自动呈现。"}
              </p>
            </div>
          )}

          <div className="access-card-footer">
            <ShieldCheck size={14} />
            <span>凭据仅存服务端 · 退出即撤销本次会话</span>
          </div>
        </section>
      </main>

      <footer className="access-footer">
        <span>
          Tuwunel Admin <b>v{config.data?.version || "1.5.0"}</b>
        </span>
        <span>开放连接 · 自主管理</span>
      </footer>
    </div>
  );
}
