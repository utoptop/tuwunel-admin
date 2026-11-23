import { useState } from "react";
import {
  Clock3,
  HardDrive,
  Play,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { admin, bytes, fmtDate, request, type Data, type Session } from "./api";
import Avatar from "./Avatar";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  JsonView,
  Loading,
  PageTitle,
  Pagination,
  Panel,
  Refresh,
  useLoad,
} from "./ui";
import type { Operate } from "./UsersRooms";
import { MediaCleanup, MediaJobs } from "./MediaJobs";
import { useInfinite, InfiniteEnd } from "./infinite";

export function MediaPage({
  operate,
  session,
}: {
  operate: Operate;
  session?: Session;
}) {
  const [tab, setTab] = useState("stats"),
    [selected, setSelected] = useState<Data[]>([]),
    [cleanup, setCleanup] = useState<Data[] | null>(null),
    [mxc, setMxc] = useState(""),
    [metadata, setMetadata] = useState<Data>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const stats = useInfinite(
    (from) =>
      admin(
        "mediaStats",
        {},
        { from, limit: 20, order_by: "media_length", dir: "b" },
      ),
    "users",
    "next_token",
    "user_id",
  );
  const params = () => {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc.trim());
    if (!match) throw new Error("请输入完整 mxc://server/media_id 地址");
    return { server_name: match[1], media_id: match[2] };
  };
  return (
    <>
      <PageTitle
        eyebrow="STORAGE & RETENTION"
        title="媒体与存储"
        description="了解媒体占用，配置保留周期，让存储持续保持有序。"
      >
        <Button
          kind="danger-soft"
          disabled={!selected.length}
          onClick={() => setCleanup(selected)}
        >
          <Trash2 size={15} />
          清理所选（{selected.length}）
        </Button>
        <Refresh
          onClick={() => {
            setSelected([]);
            stats.reload();
          }}
        />
      </PageTitle>
      <div className="tabs page-tabs">
        {[
          ["stats", "存储用量"],
          ["lifecycle", "生命周期"],
          ["tools", "媒体工具"],
        ].map(([key, title]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {title}
          </button>
        ))}
      </div>
      <div className="storage-overview">
        <div>
          <span className="storage-overview-icon">
            <HardDrive size={26} />
          </span>
          <div>
            <span>已加载用户的媒体占用</span>
            <strong>
              {bytes(
                (stats.data?.users || []).reduce(
                  (n: number, u: Data) => n + u.media_length,
                  0,
                ),
              )}
            </strong>
          </div>
        </div>
        <p>
          集中管理存储，按需保留。
          <br />
          <span>勾选多位用户批量清理，默认自动保留当前头像。</span>
        </p>
      </div>
      <MediaJobs
        onRetry={setCleanup}
        onComplete={() => {
          setSelected([]);
          stats.reload();
        }}
      />
      {cleanup && (
        <MediaCleanup
          users={cleanup}
          onClose={() => setCleanup(null)}
          onStarted={() => {
            setCleanup(null);
            setSelected([]);
          }}
        />
      )}
      {tab === "stats" ? (
        <Panel
          title="用户媒体用量"
          subtitle="按存储大小降序排列 · 统计来自服务器实际存储"
        >
          <ErrorBox error={stats.error} />
          {stats.loading && !stats.data ? (
            <Loading />
          ) : !stats.data?.users?.length ? (
            <Empty text="暂无媒体上传记录" />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="选择已加载媒体用户"
                        checked={
                          Boolean(stats.data?.users.length) &&
                          stats.data!.users.every((u: Data) =>
                            selected.some((s) => s.user_id === u.user_id),
                          )
                        }
                        onChange={(e) =>
                          setSelected(e.target.checked ? stats.data!.users : [])
                        }
                      />
                    </th>
                    <th>用户</th>
                    <th>文件数</th>
                    <th>存储用量</th>
                    <th>相对占用（已加载）</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.users.map((u: Data) => (
                    <tr key={u.user_id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择媒体用户 ${u.user_id}`}
                          checked={selected.some(
                            (s) => s.user_id === u.user_id,
                          )}
                          onChange={(e) =>
                            setSelected((v) =>
                              e.target.checked
                                ? [...v, u]
                                : v.filter((x) => x.user_id !== u.user_id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <strong>
                          {u.displayname || u.user_id.split(":")[0].slice(1)}
                        </strong>
                        <small>{u.user_id}</small>
                      </td>
                      <td>{u.media_count}</td>
                      <td>
                        <strong>{bytes(u.media_length)}</strong>
                      </td>
                      <td>
                        <div className="bar">
                          <span
                            style={{
                              width: `${(u.media_length / Math.max(1, stats.data?.users[0]?.media_length)) * 100}%`,
                            }}
                          />
                        </div>
                      </td>
                      <td>
                        <Button
                          kind="danger-soft"
                          onClick={() => setCleanup([u])}
                        >
                          <Trash2 size={14} />
                          清理
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <InfiniteEnd
            list={stats}
            count={stats.data?.users?.length || 0}
            total={stats.data?.total}
          />
        </Panel>
      ) : tab === "lifecycle" ? (
        <Lifecycle operate={operate} />
      ) : (
        <div className="stack">
          <Panel
            title="查找媒体"
            subtitle="通过 MXC 地址查询元数据或删除本地媒体"
          >
            <div className="panel-body">
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError("");
                  setMetadata(undefined);
                  setBusy(true);
                  try {
                    setMetadata(await admin("media", params()));
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input
                  aria-label="MXC 地址"
                  placeholder="mxc://example.com/media_id"
                  value={mxc}
                  onChange={(e) => {
                    setMxc(e.target.value);
                    setMetadata(undefined);
                  }}
                  required
                />
                <Button type="submit" disabled={busy}>
                  <Search size={16} />
                  查询
                </Button>
                <Button
                  kind="danger-soft"
                  disabled={!metadata}
                  onClick={() =>
                    operate({
                      title: "删除本地媒体",
                      description: mxc,
                      danger: true,
                      run: () => admin("deleteMedia", params(), {}, {}, true),
                      onDone: () => setMetadata(undefined),
                    })
                  }
                >
                  <Trash2 size={16} />
                  删除
                </Button>
              </form>
              <ErrorBox error={error} />
              {metadata && (
                <>
                  {metadata.media_type?.startsWith("image/") &&
                    session?.homeserver && (
                      <div className="user-room-row">
                        <Avatar
                          name={metadata.upload_name || mxc}
                          mxc={mxc.trim()}
                          homeserver={session.homeserver}
                          large
                        />
                        <div>
                          <strong>
                            {metadata.upload_name || "图片媒体缩略预览"}
                          </strong>
                          <code>{mxc.trim()}</code>
                          <small>
                            {metadata.media_type} ·{" "}
                            {bytes(metadata.media_length)}
                          </small>
                        </div>
                      </div>
                    )}
                  <JsonView value={metadata} />
                </>
              )}
            </div>
          </Panel>
          <Panel
            title="手动清理"
            subtitle="操作立即生效，官方 API 不提供删除预览"
          >
            <div className="tool-cards">
              <div>
                <HardDrive size={24} />
                <h3>本地媒体</h3>
                <p>按文件时间与最小大小删除。可保留用户和房间头像。</p>
                <Button
                  onClick={() =>
                    operate({
                      title: "按条件清理本地媒体",
                      description:
                        "截止时间按文件修改时间计算，不是最后访问时间。没有 dry-run，执行后无法撤销。",
                      danger: true,
                      fields: [
                        {
                          key: "before",
                          label: "截止时间",
                          type: "datetime-local",
                          required: true,
                        },
                        {
                          key: "size",
                          label: "仅清理大于此大小的文件（MiB）",
                          type: "number",
                          value: 0,
                        },
                        {
                          key: "keep_profiles",
                          label: "保留头像等资料媒体",
                          type: "checkbox",
                          value: true,
                        },
                      ],
                      run: (v) => {
                        if (v.size < 0) throw new Error("文件大小不能为负数");
                        return admin(
                          "deleteOldMedia",
                          {},
                          {
                            before_ts: new Date(v.before).getTime(),
                            size_gt: Math.round(v.size * 1048576),
                            keep_profiles: v.keep_profiles,
                          },
                          {},
                          true,
                        );
                      },
                      showResult: true,
                      onDone: stats.reload,
                    })
                  }
                >
                  设置清理条件
                </Button>
              </div>
              <div>
                <Clock3 size={24} />
                <h3>远程媒体缓存</h3>
                <p>删除指定时间之前的远程缓存。再次访问时可能重新下载。</p>
                <Button
                  onClick={() =>
                    operate({
                      title: "清理远程媒体缓存",
                      danger: true,
                      fields: [
                        {
                          key: "before",
                          label: "截止时间",
                          type: "datetime-local",
                          required: true,
                        },
                      ],
                      run: (v) =>
                        admin(
                          "purgeRemote",
                          {},
                          { before_ts: new Date(v.before).getTime() },
                          {},
                          true,
                        ),
                      showResult: true,
                    })
                  }
                >
                  清理远程缓存
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
function Lifecycle({ operate }: { operate: Operate }) {
  const result = useLoad(() => request("/policy"));
  return (
    <>
      <ErrorBox error={result.error} />
      {result.loading ? (
        <Loading />
      ) : (
        result.data && (
          <PolicyForm
            key={JSON.stringify(result.data)}
            value={result.data}
            reload={result.reload}
            operate={operate}
          />
        )
      )}
    </>
  );
}
function PolicyForm({
  value,
  reload,
  operate,
}: {
  value: Data;
  reload: () => void;
  operate: Operate;
}) {
  const [form, setForm] = useState(value),
    [token, setToken] = useState("");
  const set = (key: string, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <div className="policy-grid">
      <Panel
        title="媒体保留策略"
        subtitle="计划由本管理系统执行，需保持容器运行"
        action={
          <Badge tone={value.enabled ? "green" : ""}>
            {value.enabled ? "已启用" : "未启用"}
          </Badge>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            operate({
              title: "保存媒体生命周期策略",
              description: form.enabled
                ? `启用自动删除：本地媒体保留 ${form.localDays} 天，远程缓存保留 ${form.remoteDays} 天，每 ${form.intervalHours} 小时执行。首次执行在一个间隔后。`
                : "暂停自动媒体清理。",
              danger: form.enabled,
              run: () =>
                request("/policy", "PUT", {
                  enabled: form.enabled,
                  localDays: form.localDays,
                  remoteDays: form.remoteDays,
                  intervalHours: form.intervalHours,
                  sizeGt: form.sizeGt,
                  keepProfiles: form.keepProfiles,
                  schedulerToken: token,
                  confirm: true,
                }),
              onDone: () => {
                setToken("");
                reload();
              },
            });
          }}
        >
          <div className="panel-body">
            <label className="switch-row">
              <span>
                <strong>启用自动清理</strong>
                <small>自动删除到期媒体，请先备份必要数据</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={form.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
            </label>
            <div className="form-grid">
              {[
                ["localDays", "本地媒体保留（天）"],
                ["remoteDays", "远程缓存保留（天）"],
                ["intervalHours", "执行间隔（小时）"],
                ["sizeGt", "本地文件最小大小（字节）"],
              ].map(([key, label]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min={key === "sizeGt" ? 0 : 1}
                    step="1"
                    required
                    value={form[key]}
                    onChange={(e) =>
                      set(
                        key,
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <label className="field check-field">
              <input
                type="checkbox"
                checked={form.keepProfiles}
                onChange={(e) => set("keepProfiles", e.target.checked)}
              />
              <span>保留用户与房间资料媒体（头像）</span>
            </label>
            <label className="field">
              <span>
                独立管理员 Access Token{" "}
                {value.hasCredential && <Badge tone="green">已配置</Badge>}
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  value.hasCredential ? "留空保留已有凭据" : "启用计划时必填"
                }
              />
              <small>
                用于后台执行，与网页登录会话分开；令牌加密保存在数据卷中。
              </small>
            </label>
          </div>
          <div className="panel-foot">
            <Button type="submit" kind="primary">
              <Save size={16} />
              保存策略
            </Button>
            <Button
              disabled={!value.enabled || value.running}
              onClick={() =>
                operate({
                  title: "立即执行已保存策略",
                  description:
                    "使用已保存的保留条件清理本地媒体与远程缓存，尚未保存的修改不会生效。",
                  danger: true,
                  run: () => request("/policy/run", "POST", { confirm: true }),
                  showResult: true,
                  onDone: reload,
                })
              }
            >
              <Play size={15} />
              立即执行
            </Button>
          </div>
        </form>
      </Panel>
      <div className="stack">
        <div className="info-card">
          <ShieldCheck size={24} />
          <h3>清理规则说明</h3>
          <p>
            保留时间基于存储文件修改时间，不代表最后访问时间。恢复备份可能改变时间。
          </p>
          <p>
            本地媒体删除会影响已有消息附件。远程缓存重新获取取决于远端是否仍保存文件。
          </p>
          <a
            href="https://matrix-construct.github.io/tuwunel/development/compliance/synapse-admin.html"
            target="_blank"
            rel="noreferrer"
          >
            查看官方 API 文档 ↗
          </a>
        </div>
        <Panel title="运行状态">
          <div className="panel-body metadata">
            <span>上次执行</span>
            <strong>{fmtDate(value.lastRun)}</strong>
            <span>下次执行</span>
            <strong>
              {value.enabled ? fmtDate(value.nextRun) : "策略未启用"}
            </strong>
            <span>执行者</span>
            <code>{value.owner || "尚未配置"}</code>
            {value.lastResult && (
              <>
                <span>最近结果</span>
                <Badge tone={value.lastResult.ok ? "green" : "red"}>
                  {value.lastResult.ok ? "成功" : "失败 / 部分完成"}
                </Badge>
                <JsonView value={value.lastResult} />
              </>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
