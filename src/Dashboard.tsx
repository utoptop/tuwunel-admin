import {
  ArrowRight,
  Boxes,
  Clock3,
  HardDrive,
  LayoutGrid,
  ShieldCheck,
  Users,
} from "lucide-react";
import { admin, bytes, fmtDate, request, type Data, type Session } from "./api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Loading,
  PageTitle,
  Panel,
  Refresh,
  useLoad,
} from "./ui";
export default function Dashboard({
  session,
  navigate,
}: {
  session: Session;
  navigate: (page: string) => void;
}) {
  const result = useLoad(async () => {
    const keys = ["users", "rooms", "media", "version", "audit", "policy"];
    const results = await Promise.allSettled([
      admin("users", {}, { limit: 1, deactivated: true, locked: true }),
      admin("rooms", {}, { limit: 1 }),
      admin("mediaStats", {}, { limit: 8, order_by: "media_length", dir: "b" }),
      admin("version"),
      request("/audit"),
      request("/policy"),
    ]);
    return Object.fromEntries(
      results.map((r, i) => [
        keys[i],
        r.status === "fulfilled"
          ? { data: r.value }
          : { error: r.reason.message },
      ]),
    );
  });
  const d = result.data;
  return (
    <>
      <PageTitle
        eyebrow="YOUR HOMESERVER, AT A GLANCE"
        title="服务器概览"
        description="欢迎回来。你的 Matrix 服务器，一目了然。"
      >
        <Refresh onClick={result.reload} />
      </PageTitle>
      <div className="hero">
        <div className="hero-content">
          <Badge tone="purple">
            <span className="dot" />
            管理员会话已验证
          </Badge>
          <h2>
            让连接更简单，
            <br />
            让管理更从容。
          </h2>
          <p>
            集中管理用户、房间与媒体，
            <br />
            为你的 Matrix 社区保持良好的运行状态。
          </p>
          <Button kind="dark" onClick={() => navigate("users")}>
            管理用户
            <ArrowRight size={16} />
          </Button>
        </div>
        <div className="network-art" aria-hidden="true">
          <div className="orbit one" />
          <div className="orbit two" />
          <div className="core">
            <ShieldCheck size={42} />
          </div>
          <div className="node n1">
            <Users size={23} />
          </div>
          <div className="node n2">
            <LayoutGrid size={23} />
          </div>
          <div className="node n3">
            <HardDrive size={22} />
          </div>
          <span className="spark s1" />
          <span className="spark s2" />
        </div>
        <div className="hero-server">
          <span className="dot" />
          {new URL(session.homeserver).host}
        </div>
      </div>
      <ErrorBox error={result.error} />
      <div className="stats-grid">
        {[
          {
            name: "本地用户",
            value: d?.users?.data?.total,
            icon: Users,
            page: "users",
            label: "含已停用账号",
            error: d?.users?.error,
          },
          {
            name: "已知房间",
            value: d?.rooms?.data?.total_rooms,
            icon: LayoutGrid,
            page: "rooms",
            label: "服务器已知会话",
            error: d?.rooms?.error,
          },
          {
            name: "媒体上传者",
            value: d?.media?.data?.total,
            icon: HardDrive,
            page: "media",
            label: "有媒体占用的用户",
            error: d?.media?.error,
          },
          {
            name: "生命周期",
            value: d?.policy?.data?.enabled
              ? "已启用"
              : d?.policy?.data
                ? "未启用"
                : undefined,
            icon: Clock3,
            page: "media",
            label: d?.policy?.data?.enabled
              ? `每 ${d.policy.data.intervalHours} 小时清理`
              : "配置自动清理规则",
            error: d?.policy?.error,
          },
        ].map((s) => (
          <button
            className="stat-card"
            key={s.name}
            onClick={() => navigate(s.page)}
          >
            <div>
              <span>{s.name}</span>
              <s.icon size={19} />
            </div>
            <strong>
              {s.value === undefined
                ? "—"
                : typeof s.value === "number"
                  ? s.value.toLocaleString()
                  : s.value}
            </strong>
            <small className={s.error ? "error-text" : ""}>
              {s.error ? "暂不可用 · 进入页面查看" : s.label}
              <ArrowRight size={13} />
            </small>
          </button>
        ))}
      </div>
      <div className="dashboard-grid">
        <Panel
          title="媒体用量排行"
          subtitle="存储用量最高的 8 位用户"
          action={
            <Button kind="text" onClick={() => navigate("media")}>
              查看全部
              <ArrowRight size={14} />
            </Button>
          }
        >
          <ErrorBox error={d?.media?.error} />
          {result.loading ? (
            <Loading />
          ) : !d?.media?.data?.users?.length ? (
            <Empty text="暂无媒体占用记录" />
          ) : (
            <div className="usage-list">
              {d.media.data.users.map((u: Data, i: number) => (
                <div className="usage-row" key={u.user_id}>
                  <span className="rank">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <div className="usage-label">
                      <strong>
                        {u.displayname || u.user_id.split(":")[0].slice(1)}
                      </strong>
                      <span>{bytes(u.media_length)}</span>
                    </div>
                    <div className="bar">
                      <span
                        style={{
                          width: `${(u.media_length / Math.max(1, d.media.data.users[0].media_length)) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel
          title="最近操作"
          subtitle="本管理系统内的操作记录"
          action={
            <Button kind="text" onClick={() => navigate("audit")}>
              全部
              <ArrowRight size={14} />
            </Button>
          }
        >
          <ErrorBox error={d?.audit?.error} />
          {result.loading ? (
            <Loading />
          ) : !d?.audit?.data?.entries?.length ? (
            <Empty text="操作记录将在这里显示" />
          ) : (
            <div className="activity-list">
              {d.audit.data.entries.slice(0, 5).map((e: Data) => (
                <div className="activity" key={e.id}>
                  <span
                    className={`activity-icon ${e.status === "failed" ? "failed" : ""}`}
                  >
                    <ShieldCheck size={16} />
                  </span>
                  <div>
                    <strong>{e.action}</strong>
                    <small>{e.actor}</small>
                    <time>{fmtDate(e.at)}</time>
                  </div>
                  <span
                    className={`dot ${e.status === "failed" ? "red" : ""}`}
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <div className="server-strip">
        <span className="server-icon">
          <Boxes size={23} />
        </span>
        <div>
          <strong>{d?.version?.data?.server_name || "Tuwunel"}</strong>
          <small>
            {d?.version?.data?.server_version ||
              d?.version?.error ||
              "正在读取服务器版本"}
          </small>
        </div>
        <div className="strip-right">
          <Badge tone="purple">Matrix Admin API</Badge>
          <span>管理系统 v1.1.0</span>
        </div>
      </div>
    </>
  );
}
