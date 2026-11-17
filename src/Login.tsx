import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
  LayoutGrid,
  HardDrive,
} from "lucide-react";
import { request, type Data, type Session } from "./api";
import { Button, ErrorBox, useLoad } from "./ui";
import Brand from "./Brand";

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
    // Remove the obsolete browser-side lock preference. Deployment is the only authority.
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
              setPasswordMode(!data.oauth && !data.sso);
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setChecking(false);
          }),
      config.data.locked ? 0 : 600,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [homeserver, config.data, retry]);
  const auth = Boolean(discovery?.oauth || discovery?.sso);
  const redirect = async () => {
    if (!discovery) return;
    setBusy(true);
    setError("");
    try {
      const result = await request("/auth/start", "POST", {
        homeserver: discovery.homeserver,
        kind: discovery.oauth ? "oauth" : "sso",
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
  return (
    <div className="access-page">
      <header className="access-header">
        <Brand />
        <a
          href="https://matrix-construct.github.io/tuwunel/"
          target="_blank"
          rel="noreferrer"
        >
          使用文档 <ExternalLink size={14} />
        </a>
      </header>
      <main className="access-layout">
        <section className="access-intro">
          <span className="access-kicker">
            <span className="dot" /> YOUR MATRIX. YOUR CONTROL.
          </span>
          <h1>
            管理每一次
            <br />
            <em>连接。</em>
          </h1>
          <p>
            用户、房间与媒体，在一个工作区井然有序。
            <br />
            连接你的服务器，开始管理。
          </p>
          <div className="access-diagram" aria-hidden="true">
            <div className="diagram-server">
              <Server size={26} />
              <div>
                <strong>Matrix homeserver</strong>
                <small>你的服务器 · 你的管理空间</small>
              </div>
              <span className="diagram-status" />
            </div>
            <div className="diagram-branches">
              <span>
                <Users size={20} />
                用户
              </span>
              <span>
                <LayoutGrid size={20} />
                房间
              </span>
              <span>
                <HardDrive size={20} />
                媒体
              </span>
            </div>
          </div>
          <div className="access-note">
            <ShieldCheck size={18} />
            <span>
              使用服务器原有的身份认证
              <br />
              <small>每次登录均验证管理员权限</small>
            </span>
          </div>
        </section>
        <section className="access-card" aria-labelledby="login-heading">
          <div className="access-card-heading">
            <span className="section-index">01 / CONNECT</span>
            <h2 id="login-heading">登录管理中心</h2>
            <p>登录方式由你的 Matrix 服务器决定。</p>
          </div>
          <div className="connection-block">
            {config.data?.locked ? (
              <div className="fixed-server">
                <Server size={20} />
                <div>
                  <small>此部署的固定服务器</small>
                  <strong>{homeserver}</strong>
                </div>
                <span className="fixed-tag">固定</span>
              </div>
            ) : (
              <label className="field">
                <span>Matrix 服务器地址</span>
                <div className="connection-input">
                  <Globe2 size={18} />
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
                <small>输入服务器的完整地址，自动检测可用的登录方式。</small>
              </label>
            )}
            <div
              className={`connection-state ${discovery ? "ready" : ""}`}
              role="status"
            >
              {checking ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  正在检测服务器的登录方式…
                </>
              ) : discovery ? (
                <>
                  <Check size={14} />
                  服务器已连接
                  <span>
                    {discovery.oauth
                      ? "OAuth 认证"
                      : discovery.sso
                        ? "单点登录"
                        : discovery.password
                          ? "账号密码"
                          : "其他认证方式"}
                  </span>
                </>
              ) : (
                <>
                  <span className="dot" />
                  等待连接服务器
                </>
              )}
              <button
                type="button"
                aria-label="重新检测服务器"
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
              {auth && !passwordMode ? (
                <>
                  <div className="auth-explanation">
                    <span className="auth-icon">
                      <ShieldCheck size={24} />
                    </span>
                    <h3>通过服务器认证登录</h3>
                    <p>
                      即将前往服务器的认证页面。
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
                  {discovery.password && (
                    <button
                      className="method-switch"
                      onClick={() => setPasswordMode(true)}
                      disabled={busy}
                    >
                      使用账号密码登录
                    </button>
                  )}
                </>
              ) : discovery.password ? (
                <form
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
                        登录工作区
                        <ArrowRight size={17} />
                      </>
                    )}
                  </Button>
                  {auth && (
                    <button
                      type="button"
                      className="method-switch"
                      onClick={() => setPasswordMode(false)}
                      disabled={busy}
                    >
                      返回服务器认证登录
                    </button>
                  )}
                </form>
              ) : (
                <p className="notice">
                  服务器未提供可用的网页登录方式，请检查服务器认证配置。
                </p>
              )}
              {discovery.warning && (
                <p className="auth-warning">{discovery.warning}</p>
              )}
              <details className="token-alternative">
                <summary>
                  <KeyRound size={13} />
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
                      placeholder="管理员访问令牌"
                    />
                  </label>
                  <Button type="submit" disabled={busy || checking}>
                    验证并登录
                    <ArrowRight size={14} />
                  </Button>
                </form>
              </details>
            </div>
          )}
          {!discovery && !checking && !error && (
            <div className="await-connection">
              <Globe2 size={30} />
              <p>
                {config.loading
                  ? "正在读取部署配置…"
                  : "填写服务器地址后，登录入口将在这里显示。"}
              </p>
            </div>
          )}
          <div className="access-card-footer">
            <ShieldCheck size={14} />
            登录凭据仅在服务端保管
          </div>
        </section>
      </main>
      <footer className="access-footer">
        <span>
          TUWUNEL ADMIN <b>1.2</b>
        </span>
        <span>开放连接，自主管理。</span>
      </footer>
    </div>
  );
}
