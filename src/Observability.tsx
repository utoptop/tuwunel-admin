import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Settings2,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { request, bytes, fmtDate, type Data } from "./api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Loading,
  PageTitle,
  Panel,
  Refresh,
} from "./ui";
function Trend({ history, field }: { history: Data[]; field: string }) {
  const values = history
    .map((v) => v[field])
    .filter((v) => typeof v === "number");
  if (values.length < 2)
    return <div className="chart-wait">等待下一次采样…</div>;
  const max = Math.max(...values, 1);
  const coords = values.map((v, i) => [
    (i / (values.length - 1)) * 300,
    56 - (v / max) * 46,
  ]);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,62 ${line} 300,62`;
  const [lastX, lastY] = coords[coords.length - 1];
  const gradId = `grad-${field}`;
  return (
    <svg
      className="trend"
      viewBox="0 0 300 64"
      preserveAspectRatio="none"
      aria-label="最近采样趋势"
      role="img"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <path d="M0 58H300 M0 32H300" stroke="currentColor" opacity=".08" />
      <polygon points={area} fill={`url(#${gradId})`} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r="3" fill="currentColor" />
    </svg>
  );
}
export default function Observability() {
  const [data, setData] = useState<Data>(),
    [error, setError] = useState(""),
    [tab, setTab] = useState("metrics"),
    [filter, setFilter] = useState(""),
    [repeated, setRepeated] = useState(false);
  const load = async () => {
    try {
      setData(await request("/observability"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await request("/observability");
        if (active) {
          setData(r);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(poll, 5000);
      }
    };
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  const s = data?.snapshot,
    m = s?.metrics,
    history = s?.history || [],
    r = s?.registrations;
  const rate = (v: number) => bytes(Math.round(v)) + "/s";
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS"
        title="服务器监测"
        description="查看 Tuwunel 的运行状态、部署配置与注册来源。"
      >
        <Refresh onClick={load} />
      </PageTitle>
      <div className="tabs page-tabs">
        {[
          ["metrics", "运行指标"],
          ["configuration", "服务器配置"],
          ["registration", "注册审计"],
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
      <ErrorBox error={error} />
      {!data && !error ? (
        <Loading />
      ) : !data?.available ? (
        <Panel>
          <div className="observer-empty">
            <span className="observer-icon">
              <Activity size={32} />
            </span>
            <h2>连接服务器的运行数据</h2>
            <p>{data?.message}</p>
            <div className="observer-steps">
              <div>
                <span>01</span>
                <strong>部署只读采集器</strong>
                <small>与 Tuwunel 共享进程和网络命名空间</small>
              </div>
              <div>
                <span>02</span>
                <strong>关联服务器地址</strong>
                <small>在面板 TOML 中指定该服务器的快照</small>
              </div>
              <div>
                <span>03</span>
                <strong>接入注册审计</strong>
                <small>可选；从接入后的日志识别注册来源</small>
              </div>
            </div>
            <a
              className="btn primary"
              href="https://github.com/utoptop/tuwunel-admin/blob/main/docs/observability.md"
              target="_blank"
              rel="noreferrer"
            >
              查看部署说明
              <ExternalLink size={15} />
            </a>
          </div>
        </Panel>
      ) : (
        <>
          <div className="monitor-status">
            <span>
              <span className={`dot ${data.stale ? "offline" : ""}`} />
              {data.stale ? "快照已过期" : "采集器已连接"}
              <Badge>{s.server_name}</Badge>
            </span>
            <small>
              采集于 {fmtDate(s.generated_at)} · {data.ageSeconds} 秒前
            </small>
          </div>
          {data.stale && (
            <p className="notice warning">
              当前显示的是历史快照，不能代表服务器此刻的状态。请检查采集器是否运行。
            </p>
          )}
          {s.diagnostics?.map((v: string) => (
            <p className="notice warning" key={v}>
              {v}
            </p>
          ))}
          {tab === "metrics" ? (
            <>
              <div className="metrics-grid">
                {[
                  [
                    "常驻内存",
                    "rss_bytes",
                    MemoryStick,
                    (v: number) => bytes(v),
                    "Tuwunel 进程 RSS",
                  ],
                  [
                    "CPU 使用率",
                    "cpu_percent",
                    Cpu,
                    (v: number) => v.toFixed(1) + "%",
                    "100% 等于使用一个 CPU 核心",
                  ],
                  [
                    "网络接收",
                    "received_bytes_per_second",
                    ArrowDownLeft,
                    rate,
                    "目标网络命名空间 · 不含 loopback",
                  ],
                  [
                    "网络发送",
                    "sent_bytes_per_second",
                    ArrowUpRight,
                    rate,
                    "目标网络命名空间 · 不含 loopback",
                  ],
                  [
                    "磁盘读取",
                    "read_bytes_per_second",
                    HardDrive,
                    rate,
                    "进程实际磁盘读取字节",
                  ],
                  [
                    "磁盘写入",
                    "write_bytes_per_second",
                    HardDrive,
                    rate,
                    "进程实际磁盘写入字节",
                  ],
                ].map(([name, field, Icon, format, note]: any) => (
                  <div className="metric-card" key={field}>
                    <div>
                      <span>{name}</span>
                      <Icon size={18} />
                    </div>
                    <strong>
                      {m?.[field] === null || m?.[field] === undefined
                        ? "—"
                        : format(m[field])}
                    </strong>
                    <Trend history={history} field={field} />
                    <small>{note}</small>
                  </div>
                ))}
              </div>
              <div className="concurrency-grid">
                <Panel title="线程与连接" subtitle="实时进程与网络观测">
                  <div className="runtime-row">
                    <Cpu size={19} />
                    <span>进程线程数</span>
                    <strong>{m?.threads ?? "—"}</strong>
                  </div>
                  <div className="runtime-row">
                    <Network size={19} />
                    <span>已建立 TCP 连接</span>
                    <strong>{m?.tcp_connections ?? "—"}</strong>
                  </div>
                  <div className="runtime-row">
                    <Activity size={19} />
                    <span>HTTP 活跃请求并发</span>
                    <Badge>上游未提供</Badge>
                  </div>
                </Panel>
                <Panel title="采样说明">
                  <div className="panel-body">
                    <p>
                      每 5 秒更新页面，保留采集器最近 120
                      个样本。首次采样、进程重启或计数器重置时，速率暂时显示为「—」。
                    </p>
                    <p>
                      带宽为网络收发速率；线程数和 TCP 连接数不等于 HTTP
                      请求并发。并发相关配置可在「服务器配置」中查看。
                    </p>
                    <p className="muted">
                      网络数据属于目标网络命名空间；使用 host
                      网络时包含该命名空间的其他进程流量。
                    </p>
                  </div>
                </Panel>
              </div>
            </>
          ) : tab === "configuration" ? (
            <Panel title="部署配置快照" subtitle="已配置的非敏感字段 · 只读">
              <p className="notice">
                来自挂载的 Tuwunel TOML
                文件，包含显式填写的安全字段。未填写的默认值、环境变量覆盖及运行时变更不在此快照内。令牌、密码与密钥不会输出。
              </p>
              {Object.keys(s.configuration).length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>配置项</th>
                        <th>文件中的值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(s.configuration).map(([k, v]) => (
                        <tr key={k}>
                          <td>
                            <code>{k}</code>
                          </td>
                          <td>
                            <code>{JSON.stringify(v)}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty text="尚未挂载 Tuwunel 配置文件，或文件中没有支持展示的字段" />
              )}
            </Panel>
          ) : (
            <>
              <div className="audit-context">
                <ShieldCheck size={20} />
                <div>
                  <strong>注册来源需要注册审计日志</strong>
                  <p>
                    只记录接入后的可见日志。401
                    通常是正常认证挑战，单独计数；没有成功注册响应中的用户
                    ID，就无法关联账号的创建 IP。MAS 注册需在 MAS
                    一侧提供相同格式的审计事件。
                  </p>
                </div>
              </div>
              {!r.available ? (
                <Panel>
                  <Empty text="未接入注册日志，无法判断历史创建 IP 或注册失败来源" />
                </Panel>
              ) : (
                <>
                  <div className="toolbar">
                    <input
                      aria-label="搜索注册 IP 或账号"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="搜索 IP 或 Matrix 用户 ID"
                    />
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={repeated}
                        onChange={(e) => setRepeated(e.target.checked)}
                      />
                      仅看多次拒绝 / 限流（≥3）
                    </label>
                  </div>
                  <Panel
                    title="注册请求来源"
                    subtitle="最近 24 小时 · 当前日志可见范围"
                  >
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>来源 IP</th>
                            <th>成功</th>
                            <th>拒绝</th>
                            <th>限流</th>
                            <th>认证挑战</th>
                            <th>服务错误</th>
                            <th>最近请求</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.ips
                            .filter(
                              (v: Data) =>
                                v.ip.includes(filter) &&
                                (!repeated || v.refused + v.limited >= 3),
                            )
                            .slice(0, 200)
                            .map((v: Data) => (
                              <tr key={v.ip}>
                                <td>
                                  <code>{v.ip}</code>
                                </td>
                                <td>{v.success}</td>
                                <td>
                                  <Badge tone={v.refused ? "red" : ""}>
                                    {v.refused}
                                  </Badge>
                                </td>
                                <td>{v.limited}</td>
                                <td>{v.challenges}</td>
                                <td>{v.server_errors}</td>
                                <td>{fmtDate(v.last_seen)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {!r.ips.length && (
                      <Empty text="可见日志中没有最近 24 小时的注册请求" />
                    )}
                  </Panel>
                  <Panel
                    title="已确认的账号创建来源"
                    subtitle="仅关联成功注册响应的用户 ID；最多展示 200 条搜索结果"
                  >
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Matrix 用户 ID</th>
                            <th>创建 IP</th>
                            <th>注册时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.accounts
                            .filter((v: Data) =>
                              (v.user_id + " " + v.ip).includes(filter),
                            )
                            .slice(0, 200)
                            .map((v: Data) => (
                              <tr key={v.user_id}>
                                <td>
                                  <code>{v.user_id}</code>
                                </td>
                                <td>
                                  <code>{v.ip}</code>
                                </td>
                                <td>{fmtDate(v.at)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {!r.accounts.length && (
                      <Empty text="日志没有包含成功注册的用户 ID，暂不能关联创建 IP" />
                    )}
                  </Panel>
                  <p className="footnote">
                    最早可见事件：{fmtDate(r.since)}。读取当前日志最后 8 MiB；
                    {r.truncated
                      ? "当前结果已截断，"
                      : "日志轮转后的旧文件不在此范围，"}
                    请保留原始日志用于完整审计。无效日志行：{r.invalid_lines}
                    。来源表最多展示 200 个匹配 IP。
                  </p>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
