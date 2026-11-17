import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  ChevronDown,
  Code2,
  ExternalLink,
  Globe2,
  HardDrive,
  KeyRound,
  LockKeyhole,
  LayoutDashboard,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Menu,
  ShieldCheck,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { request, setSession, type Session } from "./api";
import {
  ActionDialog,
  Badge,
  Button,
  ErrorBox,
  Loading,
  useLoad,
  type Operation,
} from "./ui";
import Dashboard from "./Dashboard";
import { RoomsPage, UsersPage } from "./UsersRooms";
import { MediaPage } from "./Media";
import {
  AuditPage,
  ExplorerPage,
  FederationPage,
  TasksPage,
  TokensPage,
} from "./System";
const pages = [
  ["overview", "服务器概览", LayoutDashboard],
  ["users", "用户管理", Users],
  ["rooms", "房间管理", LayoutGrid],
  ["media", "媒体与存储", HardDrive],
  ["tokens", "注册令牌", KeyRound],
  ["federation", "联邦连接", Globe2],
  ["tasks", "后台任务", Terminal],
  ["audit", "操作审计", Activity],
  ["api", "高级 API", Code2],
] as const;
function Brand() {
  return (
    <div className="brand">
      <img src="/favicon.svg" alt="" />
      <div>
        <strong>
          tuwunel<span>admin</span>
        </strong>
        <small>MATRIX CONTROL CENTER</small>
      </div>
    </div>
  );
}
export default function App() {
  const [session, saveSession] = useState<Session | null>(null),
    [initial, setInitial] = useState(true),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [menu, setMenu] = useState(false),
    [operation, setOperation] = useState<Operation | null>(null);
  const login = (s: Session | null) => {
    setSession(s);
    saveSession(s);
    setOperation(null);
  };
  useEffect(() => {
    request("/session")
      .then(login)
      .catch(() => {})
      .finally(() => setInitial(false));
    const expired = () => login(null);
    window.addEventListener("session-expired", expired);
    const hash = () => setPage(location.hash.slice(1) || "overview");
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  const navigate = (value: string) => {
    location.hash = value;
    setPage(value);
    setMenu(false);
  };
  if (initial)
    return (
      <div className="boot">
        <Brand />
        <Loading />
      </div>
    );
  if (!session) return <Login onLogin={login} />;
  const name = session.userId.slice(1).split(":")[0];
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <Brand />
        <div className="workspace">
          <span className="workspace-icon">
            <Globe2 size={18} />
          </span>
          <div>
            <strong>{new URL(session.homeserver).host}</strong>
            <small>
              <span className="dot" />
              管理工作区
            </small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">工作区</div>
        <nav>
          {pages.map(([key, label, Icon], i) => (
            <div key={key}>
              {i === 6 && <div className="nav-label secondary">系统工具</div>}
              <button
                className={`nav-item ${page === key ? "active" : ""}`}
                onClick={() => navigate(key)}
              >
                <Icon size={18} />
                {label}
                {key === "overview" && <span className="nav-dot" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            href="https://matrix-construct.github.io/tuwunel/"
            target="_blank"
            rel="noreferrer"
          >
            <span>官方文档</span>
            <ExternalLink size={14} />
          </a>
          <div className="version">
            <span>tuwunel admin</span>
            <Badge>v1.1</Badge>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              kind="icon mobile-menu"
              title="打开导航"
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </Button>
            <span>工作区</span>
            <span className="slash">/</span>
            <strong>
              {pages.find(([key]) => key === page)?.[1] || "服务器概览"}
            </strong>
          </div>
          <div className="topbar-right">
            <Badge tone="green">
              <ShieldCheck size={12} />
              管理员
            </Badge>
            <span className="top-separator" />
            <span className="user-avatar">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="top-name">{name}</span>
            <Button
              kind="icon"
              title="退出登录"
              onClick={() =>
                setOperation({
                  title: "退出管理系统",
                  description:
                    "退出当前网页登录。独立配置的媒体清理计划会继续运行。",
                  submitLabel: "退出登录",
                  run: () => request("/logout", "POST", {}),
                  onDone: () => login(null),
                })
              }
            >
              <LogOut size={16} />
            </Button>
          </div>
        </header>
        <main key={page}>
          {page === "users" ? (
            <UsersPage session={session} operate={setOperation} />
          ) : page === "rooms" ? (
            <RoomsPage operate={setOperation} />
          ) : page === "media" ? (
            <MediaPage operate={setOperation} />
          ) : page === "tokens" ? (
            <TokensPage operate={setOperation} />
          ) : page === "federation" ? (
            <FederationPage operate={setOperation} />
          ) : page === "tasks" ? (
            <TasksPage />
          ) : page === "audit" ? (
            <AuditPage />
          ) : page === "api" ? (
            <ExplorerPage operate={setOperation} />
          ) : (
            <Dashboard session={session} navigate={navigate} />
          )}
          <footer>
            <span>Tuwunel Admin</span>
            <span>让沟通自由，让管理有序。</span>
          </footer>
        </main>
      </div>
      {operation && (
        <ActionDialog
          key={operation.title}
          operation={operation}
          onClose={() => setOperation(null)}
        />
      )}
    </div>
  );
}
function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const config = useLoad(() => request("/config"));
  const [homeserver, setHomeserver] = useState("");
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!config.data) return;
    let saved = "";
    try {
      saved = localStorage.getItem("tuwunel-admin.pinned-server") || "";
    } catch {
      /* Storage may be disabled. */
    }
    const allowed = config.data.allowedHomeservers || [];
    if (
      config.data.locked ||
      (saved &&
        allowed.length &&
        !allowed.includes(saved) &&
        saved !== config.data.homeserver)
    )
      saved = "";
    setHomeserver(saved || config.data.homeserver || "");
    setPinned(Boolean(saved));
  }, [config.data]);
  const [mode, setMode] = useState("password"),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login-shell">
      <div className="login-story">
        <Brand />
        <div className="login-intro">
          <div className="eyebrow">BUILT FOR YOUR MATRIX</div>
          <h1>
            你的服务器，
            <br />
            尽在掌握。
          </h1>
          <p>
            从每一位用户到每一个房间，
            <br />
            一个安静、高效的 Tuwunel 管理空间。
          </p>
          <div className="login-visual">
            <div className="login-orbit" />
            <div className="visual-window">
              <div className="window-dots">
                <i />
                <i />
                <i />
              </div>
              <div className="visual-title">
                <ShieldCheck size={24} />
                <span>连接 · 管理 · 守护</span>
              </div>
              <div className="visual-lines">
                <span />
                <span />
                <span />
              </div>
              <div className="visual-icons">
                <Users />
                <LayoutGrid />
                <HardDrive />
              </div>
            </div>
            <span className="floating-lock">
              <ShieldCheck size={30} />
            </span>
          </div>
        </div>
        <span className="login-copyright">TUWUNEL ADMIN · OPEN SOURCE</span>
      </div>
      <div className="login-form-side">
        <div className="login-form">
          <span className="login-mark">
            <ShieldCheck size={27} />
          </span>
          <h2>登录管理中心</h2>
          <p>使用 Matrix 服务器管理员账号继续</p>
          <label className="field server-field">
            <span>
              Matrix 服务器地址{" "}
              {config.data?.locked && (
                <Badge tone="purple">
                  <LockKeyhole size={11} />
                  部署配置已锁定
                </Badge>
              )}
            </span>
            <div
              className={`server-input ${config.data?.locked || pinned ? "locked" : ""}`}
            >
              {config.data?.locked || pinned ? (
                <LockKeyhole size={17} />
              ) : (
                <Globe2 size={17} />
              )}
              <input
                aria-label="Matrix 服务器地址"
                type="url"
                value={homeserver}
                readOnly={Boolean(config.data?.locked || pinned)}
                placeholder="https://matrix.example.com"
                autoComplete="url"
                list="allowed-servers"
                onChange={(e) => {
                  setHomeserver(e.target.value);
                  setError("");
                }}
              />
            </div>
            <datalist id="allowed-servers">
              {config.data?.allowedHomeservers?.map((server: string) => (
                <option key={server} value={server} />
              ))}
            </datalist>
            <small>
              {config.data?.locked
                ? "此部署只允许连接上方服务器，地址由配置文件管理。"
                : "输入完整的服务器地址。未在部署配置中列出的地址仅支持公网 HTTPS。"}
            </small>
          </label>
          {!config.data?.locked && (
            <label className="field check-field server-pin">
              <input
                type="checkbox"
                checked={pinned}
                disabled={!homeserver.trim()}
                onChange={(e) => {
                  const checked = e.target.checked;
                  try {
                    if (checked) {
                      const url = new URL(homeserver.trim());
                      if (
                        !["https:", "http:"].includes(url.protocol) ||
                        url.username ||
                        url.password ||
                        url.pathname !== "/" ||
                        url.search ||
                        url.hash
                      )
                        throw new Error("请输入不含路径或凭据的完整服务器地址");
                      localStorage.setItem(
                        "tuwunel-admin.pinned-server",
                        url.origin,
                      );
                      setHomeserver(url.origin);
                    } else
                      localStorage.removeItem("tuwunel-admin.pinned-server");
                    setPinned(checked);
                    setError("");
                  } catch (e) {
                    setError((e as Error).message || "无法保存服务器地址");
                  }
                }}
              />
              <span>记住并锁定此地址（当前浏览器）</span>
            </label>
          )}
          <div className="tabs">
            <button
              className={mode === "password" ? "active" : ""}
              onClick={() => setMode("password")}
            >
              账号密码
            </button>
            <button
              className={mode === "token" ? "active" : ""}
              onClick={() => setMode("token")}
            >
              Access Token
            </button>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const s = await request(
                  "/login",
                  "POST",
                  mode === "password"
                    ? { username, password, homeserver }
                    : { accessToken: token, homeserver },
                );
                setPassword("");
                setToken("");
                onLogin(s);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === "password" ? (
              <>
                <label className="field">
                  <span>管理员账号</span>
                  <input
                    required
                    value={username}
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
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="输入账号密码"
                    autoComplete="current-password"
                  />
                </label>
              </>
            ) : (
              <label className="field">
                <span>管理员访问令牌</span>
                <input
                  required
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="粘贴 Matrix Access Token"
                  autoComplete="off"
                />
                <small>
                  适用于 SSO / MAS 登录；从已有 Matrix 客户端获取令牌。
                </small>
              </label>
            )}
            <ErrorBox error={error || config.error} />
            {config.data && !config.data.configured && (
              <p className="notice">
                请在 config.toml 中设置 matrix.homeserver，或关闭 matrix.locked
                以允许输入服务器地址。
              </p>
            )}
            <Button
              kind="primary login-submit"
              type="submit"
              disabled={busy || !config.data?.configured || !homeserver.trim()}
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <>
                  进入管理中心
                  <ArrowRight size={17} />
                </>
              )}
            </Button>
          </form>
          <div className="login-security">
            <ShieldCheck size={15} />
            <span>凭据由服务端保管，不存入浏览器本地存储。</span>
          </div>
          <a
            className="login-docs"
            href="https://matrix-construct.github.io/tuwunel/"
            target="_blank"
            rel="noreferrer"
          >
            Tuwunel 官方文档
            <ExternalLink size={13} />
          </a>
        </div>
        <div className="login-version">Tuwunel Admin 1.1.0</div>
      </div>
    </div>
  );
}
