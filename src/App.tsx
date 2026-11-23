import { useEffect, useState } from "react";
import Brand from "./Brand";
import ThemeToggle from "./ThemeToggle";
import Avatar from "./Avatar";
import Login from "./Login";
import {
  Activity,
  Code2,
  ExternalLink,
  Globe2,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
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
import Observability from "./Observability";
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
  ["monitor", "服务器监测", Activity],
  ["tokens", "注册令牌", KeyRound],
  ["federation", "联邦连接", Globe2],
  ["tasks", "后台任务", Terminal],
  ["audit", "操作审计", ShieldCheck],
  ["api", "高级 API", Code2],
] as const;
export default function App() {
  const [session, saveSession] = useState<Session | null>(null),
    [initial, setInitial] = useState(true),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [menu, setMenu] = useState(false),
    [operation, setOperation] = useState<Operation | null>(null);
  const context = useLoad(
    () => (session ? request("/context") : Promise.resolve(null)),
    [session?.userId, session?.homeserver],
  );
  const login = (s: Session | null) => {
    setSession(s);
    saveSession(s);
    setOperation(null);
  };
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [page, session?.homeserver]);
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
  const name =
    context.data?.profile?.displayname || session.userId.slice(1).split(":")[0];
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
              {context.data?.version?.server_version
                ? `${context.data.version.server_name || "Tuwunel"} ${context.data.version.server_version}`
                : context.data?.versionError
                  ? "版本读取失败"
                  : "正在读取版本…"}
            </small>
          </div>
          <ShieldCheck size={14} />
        </div>
        <div className="nav-label">工作区</div>
        <nav>
          {pages.map(([key, label, Icon], i) => (
            <div key={key}>
              {i === 7 && <div className="nav-label secondary">系统工具</div>}
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
            <Badge>v1.5</Badge>
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
            <span>管理控制台</span>
            <span className="slash">/</span>
            <strong>
              {pages.find(([key]) => key === page)?.[1] || "服务器概览"}
            </strong>
          </div>
          <div className="topbar-right">
            <ThemeToggle />
            <div className="admin-chip">
              <Avatar
                name={name}
                mxc={context.data?.profile?.avatar_url}
                homeserver={session.homeserver}
              />
              <span className="top-name">{name}</span>
              <Badge tone="green">
                <ShieldCheck size={11} />
                管理员
              </Badge>
            </div>
            <Button
              kind="icon logout-btn"
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
            <RoomsPage session={session} operate={setOperation} />
          ) : page === "media" ? (
            <MediaPage session={session} operate={setOperation} />
          ) : page === "monitor" ? (
            <Observability />
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
            <span>开放连接，自主管理。</span>
          </footer>
        </main>
      </div>
      {operation && (
        <ActionDialog
          key={operation.title}
          operation={{
            ...operation,
            onDone: () => {
              operation.onDone?.();
              context.reload();
            },
          }}
          onClose={() => setOperation(null)}
        />
      )}
    </div>
  );
}
