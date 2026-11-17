import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Code2,
  Globe2,
  Plus,
  Search,
  Send,
  Terminal,
  Trash2,
} from "lucide-react";
import { admin, fmtDate, request, type Data, type Endpoint } from "./api";
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

export function TokensPage({ operate }: { operate: Operate }) {
  const result = useLoad(() => admin("tokens"));
  const fields = (row: Data = {}) => [
    {
      key: "uses_allowed",
      label: "允许使用次数（留空为不限）",
      type: "number",
      value: row.uses_allowed ?? "",
    },
    {
      key: "expiry_time",
      label: "有效期（留空为不过期）",
      type: "datetime-local",
      value: row.expiry_time
        ? new Date(
            row.expiry_time -
              new Date(row.expiry_time).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "",
    },
  ];
  const body = (v: Data) => {
    if (
      v.uses_allowed !== "" &&
      (!Number.isInteger(v.uses_allowed) || v.uses_allowed < 0)
    )
      throw new Error("使用次数必须是非负整数");
    return {
      uses_allowed: v.uses_allowed === "" ? null : v.uses_allowed,
      expiry_time: v.expiry_time ? new Date(v.expiry_time).getTime() : null,
    };
  };
  return (
    <>
      <PageTitle
        eyebrow="REGISTRATION"
        title="注册令牌"
        description="控制新用户注册的次数与有效期。MAS 模式下此功能不可用。"
      >
        <Button
          kind="primary"
          onClick={() =>
            operate({
              title: "创建注册令牌",
              fields: [
                { key: "token", label: "自定义令牌（留空自动生成）" },
                ...fields(),
              ],
              run: (v) =>
                admin(
                  "createToken",
                  {},
                  {},
                  {
                    ...body(v),
                    ...(v.token ? { token: v.token } : { length: 24 }),
                  },
                  true,
                ),
              showResult: true,
              onDone: result.reload,
            })
          }
        >
          <Plus size={16} />
          创建令牌
        </Button>
      </PageTitle>
      <Panel title="令牌列表" action={<Refresh onClick={result.reload} />}>
        <ErrorBox error={result.error} />
        {result.loading ? (
          <Loading />
        ) : !result.data?.registration_tokens?.length ? (
          <Empty text="暂无注册令牌" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>令牌</th>
                  <th>已用 / 上限</th>
                  <th>待完成</th>
                  <th>有效期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {result.data.registration_tokens.map((t: Data) => (
                  <tr key={t.token}>
                    <td>
                      <code>{t.token}</code>
                    </td>
                    <td>
                      {t.completed} / {t.uses_allowed ?? "不限"}
                    </td>
                    <td>{t.pending}</td>
                    <td>{t.expiry_time ? fmtDate(t.expiry_time) : "不过期"}</td>
                    <td>
                      <div className="actions">
                        <Button
                          kind="text"
                          onClick={() =>
                            operate({
                              title: "编辑注册令牌",
                              fields: fields(t),
                              run: (v) =>
                                admin(
                                  "saveToken",
                                  { token: t.token },
                                  {},
                                  body(v),
                                  true,
                                ),
                              onDone: result.reload,
                            })
                          }
                        >
                          编辑
                        </Button>
                        <Button
                          kind="danger-soft"
                          onClick={() =>
                            operate({
                              title: "删除注册令牌",
                              description:
                                "使用此令牌的新注册将被拒绝。已注册账号不受影响。",
                              danger: true,
                              run: () =>
                                admin(
                                  "deleteToken",
                                  { token: t.token },
                                  {},
                                  {},
                                  true,
                                ),
                              onDone: result.reload,
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
export function FederationPage({ operate }: { operate: Operate }) {
  const [from, setFrom] = useState(0),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  const result = useLoad(
    () => admin("destinations", {}, { from, limit: 20, destination: query }),
    [from, query],
  );
  return (
    <>
      <PageTitle
        eyebrow="FEDERATION"
        title="联邦连接"
        description="查看目标服务器的连接状态，管理退避与重试。"
      >
        <Refresh onClick={result.reload} />
      </PageTitle>
      <Panel>
        <div className="toolbar">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
              setFrom(0);
            }}
          >
            <Search size={17} />
            <input
              aria-label="搜索联邦目标"
              placeholder="搜索服务器域名…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="submit">搜索</button>
          </form>
        </div>
        <ErrorBox error={result.error} />
        {result.loading ? (
          <Loading />
        ) : !result.data?.destinations?.length ? (
          <Empty text="暂无联邦目标" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>目标服务器</th>
                  <th>重试间隔</th>
                  <th>最后重试</th>
                  <th>失败开始</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.data.destinations.map((d: Data) => (
                  <tr key={d.destination}>
                    <td>
                      <div className="inline">
                        <Globe2 size={17} />
                        <strong>{d.destination}</strong>
                      </div>
                    </td>
                    <td>
                      <Badge tone={d.retry_interval ? "amber" : "green"}>
                        {d.retry_interval ? `${d.retry_interval} ms` : "无退避"}
                      </Badge>
                    </td>
                    <td>{fmtDate(d.retry_last_ts)}</td>
                    <td>{fmtDate(d.failure_ts)}</td>
                    <td>
                      <div className="actions">
                        <Button
                          kind="text"
                          onClick={() =>
                            operate({
                              title: "目标详情",
                              run: () =>
                                admin("destination", {
                                  destination: d.destination,
                                }),
                              showResult: true,
                            })
                          }
                        >
                          详情
                        </Button>
                        <Button
                          kind="text"
                          onClick={() =>
                            operate({
                              title: "共享房间",
                              run: () =>
                                admin(
                                  "destinationRooms",
                                  { destination: d.destination },
                                  { from: 0, limit: 100 },
                                ),
                              showResult: true,
                              description:
                                "显示前 100 项；更多结果可在高级 API 中分页查询。",
                            })
                          }
                        >
                          房间
                        </Button>
                        <Button
                          onClick={() =>
                            operate({
                              title: "重试联邦连接",
                              description: d.destination,
                              run: () =>
                                admin(
                                  "resetConnection",
                                  { destination: d.destination },
                                  {},
                                  {},
                                  true,
                                ),
                              onDone: result.reload,
                            })
                          }
                        >
                          重试连接
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          from={from}
          next={result.data?.next_token}
          total={result.data?.total}
          onChange={setFrom}
        />
      </Panel>
    </>
  );
}
export function TasksPage() {
  const result = useLoad(() => admin("tasks"));
  return (
    <>
      <PageTitle
        eyebrow="BACKGROUND OPERATIONS"
        title="后台任务"
        description="跟踪房间删除、历史清理与用户事件撤回的执行结果。"
      >
        <Refresh onClick={result.reload} />
      </PageTitle>
      <Panel>
        <ErrorBox error={result.error} />
        {result.loading ? (
          <Loading />
        ) : !result.data?.scheduled_tasks?.length ? (
          <Empty text="暂无后台管理任务" />
        ) : (
          <div className="task-list">
            {result.data.scheduled_tasks.map((task: Data) => (
              <details key={task.id} className="task">
                <summary>
                  <div>
                    <Terminal size={18} />
                    <strong>{task.action}</strong>
                    <code>{task.id}</code>
                  </div>
                  <div>
                    <span className="muted">{fmtDate(task.timestamp_ms)}</span>
                    <Badge
                      tone={
                        task.status === "complete"
                          ? "green"
                          : task.status === "failed"
                            ? "red"
                            : "purple"
                      }
                    >
                      {task.status}
                    </Badge>
                  </div>
                </summary>
                <JsonView value={task} />
              </details>
            ))}
          </div>
        )}
      </Panel>
      <p className="footnote">
        此页是 Tuwunel 的后台任务；媒体生命周期计划的运行状态位于「媒体与存储 →
        生命周期」。
      </p>
    </>
  );
}
export function AuditPage() {
  const [search, setSearch] = useState("");
  const result = useLoad(() => request("/audit"));
  const rows = result.data?.entries?.filter((e: Data) =>
    `${e.actor} ${e.action} ${e.target}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        eyebrow="ACTIVITY LOG"
        title="操作审计"
        description="追踪本管理系统发起的管理操作，最多保留最近 2,000 条。"
      >
        <Refresh onClick={result.reload} />
      </PageTitle>
      <Panel>
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="搜索审计"
              placeholder="搜索操作、账号或目标…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <ErrorBox error={result.error} />
        {result.loading ? (
          <Loading />
        ) : !rows?.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>执行者</th>
                  <th>目标</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e: Data) => (
                  <tr key={e.id}>
                    <td className="nowrap">{fmtDate(e.at)}</td>
                    <td>
                      <strong>{e.action}</strong>
                    </td>
                    <td>
                      <code>{e.actor}</code>
                    </td>
                    <td className="break">{e.target || "—"}</td>
                    <td>
                      <Badge tone={e.status === "success" ? "green" : "red"}>
                        {e.status === "success" ? "成功" : "失败"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="footnote">
        不记录密码、访问令牌或请求正文。不包含其他 Matrix
        客户端或控制台发起的操作。
      </p>
    </>
  );
}
export function ExplorerPage({ operate }: { operate: Operate }) {
  const result = useLoad<Endpoint[]>(() => request("/catalog"));
  const [selected, setSelected] = useState(""),
    [filter, setFilter] = useState("");
  const endpoint = result.data?.find((e) => e.id === selected);
  return (
    <>
      <PageTitle
        eyebrow="ADMIN API EXPLORER"
        title="高级 API"
        description="覆盖官方已实现的管理端点；按当前服务器版本返回实际结果。"
      >
        <a
          className="btn"
          href="https://matrix-construct.github.io/tuwunel/development/compliance/synapse-admin.html"
          target="_blank"
          rel="noreferrer"
        >
          官方文档
          <ArrowUpRight size={15} />
        </a>
      </PageTitle>
      <ErrorBox error={result.error} />
      {result.loading ? (
        <Loading />
      ) : (
        <div className="explorer">
          <Panel>
            <div className="catalog-search">
              <Search size={16} />
              <input
                aria-label="筛选 API"
                placeholder="搜索操作或路径…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="catalog-list">
              {result.data
                ?.filter((e) =>
                  `${e.label} ${e.path} ${e.group}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((e) => (
                  <button
                    key={e.id}
                    className={`catalog-item ${selected === e.id ? "active" : ""}`}
                    onClick={() => setSelected(e.id)}
                  >
                    <span
                      className={`method ${e.method === "GET" ? "get" : "write"}`}
                    >
                      {e.method}
                    </span>
                    <span>
                      <strong>{e.label}</strong>
                      <small>{e.group}</small>
                    </span>
                  </button>
                ))}
            </div>
          </Panel>
          {endpoint ? (
            <EndpointForm
              key={endpoint.id}
              endpoint={endpoint}
              operate={operate}
            />
          ) : (
            <Panel>
              <div className="explorer-welcome">
                <Code2 size={42} />
                <h2>选择一个管理操作</h2>
                <p>
                  从左侧选择端点，填写路径参数、查询参数与 JSON
                  请求体。所有写操作都需要确认。
                </p>
                <Badge tone="purple">{result.data?.length} 个操作</Badge>
                <p>
                  未实现的隔离媒体、举报管理等 API
                  不会被列为可用。旧版服务器可能不具备新版接口。
                </p>
              </div>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
function EndpointForm({
  endpoint,
  operate,
}: {
  endpoint: Endpoint;
  operate: Operate;
}) {
  const [params, setParams] = useState<Data>({}),
    [query, setQuery] = useState(JSON.stringify(endpoint.query, null, 2)),
    [body, setBody] = useState(JSON.stringify(endpoint.body ?? {}, null, 2)),
    [result, setResult] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const parse = (value: string) => {
    const p = JSON.parse(value);
    if (!p || Array.isArray(p) || typeof p !== "object")
      throw new Error("请输入 JSON 对象");
    return p;
  };
  const execute = async () => {
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(
        await admin(endpoint.id, params, parse(query), parse(body), true),
      );
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={endpoint.label} subtitle={endpoint.group}>
      <form
        className="panel-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (endpoint.method === "GET") void execute().catch(() => {});
          else
            operate({
              title: endpoint.label,
              description:
                "将向真实服务器执行此管理 API。请检查路径、参数与正文。操作可能无法撤销。",
              danger: true,
              run: execute,
            });
        }}
      >
        <div className="endpoint-path">
          <Badge tone={endpoint.method === "GET" ? "green" : "amber"}>
            {endpoint.method}
          </Badge>
          <code>{endpoint.path}</code>
        </div>
        {endpoint.note && <p className="notice">{endpoint.note}</p>}
        {[...endpoint.path.matchAll(/\{(\w+)\}/g)].map(([, key]) => (
          <label className="field" key={key}>
            <span>{key}</span>
            <input
              required
              value={params[key] || ""}
              onChange={(e) => setParams({ ...params, [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="field">
          <span>查询参数（JSON）</span>
          <textarea
            className="code-input"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={5}
          />
        </label>
        {endpoint.method !== "GET" && (
          <label className="field">
            <span>请求正文（JSON）</span>
            <textarea
              className="code-input"
              spellCheck={false}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
            />
          </label>
        )}
        <Button kind="primary" type="submit" disabled={busy}>
          <Send size={15} />
          {busy ? "请求中…" : "执行请求"}
        </Button>
        <ErrorBox error={error} />
        {result !== undefined && (
          <div className="api-result">
            <h3>
              <CheckCircle2 size={16} />
              服务器响应
            </h3>
            <JsonView value={result} />
          </div>
        )}
      </form>
    </Panel>
  );
}
