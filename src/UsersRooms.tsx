import { useState } from "react";
import Avatar from "./Avatar";
import { MediaCleanup } from "./MediaJobs";
import { useInfinite, InfiniteEnd } from "./infinite";
import { BridgeCleanup, BridgeJobs } from "./BridgeCleanup";
import {
  ArrowUpRight,
  ChevronRight,
  KeyRound,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { admin, request, fmtDate, bytes, type Data, type Session } from "./api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  JsonView,
  Loading,
  Modal,
  PageTitle,
  Pagination,
  Panel,
  Refresh,
  useLoad,
  type Operation,
} from "./ui";
export type Operate = (operation: Operation) => void;
const userId = (value: string, session: Session) =>
  value.startsWith("@")
    ? value
    : `@${value}:${session.userId.slice(session.userId.indexOf(":") + 1)}`;
function Status({ user }: { user: Data }) {
  return (
    <Badge tone={user.deactivated ? "red" : user.locked ? "amber" : "green"}>
      {user.deactivated ? "已停用" : user.locked ? "已锁定" : "正常"}
    </Badge>
  );
}
export function UsersPage({
  session,
  operate,
}: {
  session: Session;
  operate: Operate;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState(""),
    [group, setGroup] = useState("regular"),
    [checked, setChecked] = useState<string[]>([]),
    [cleanup, setCleanup] = useState<Data | null>(null);
  const directoryFilter = { search: query, group, status: filter };
  const result = useInfinite(
    (from, refresh) =>
      request("/directory", "POST", { ...directoryFilter, from, refresh }),
    "users",
    "next_token",
    "name",
    [query, filter, group],
  );
  const reload = () => {
    setChecked([]);
    result.reload();
  };
  const switchGroup = (value: string) => {
    setGroup(value);
    setChecked([]);
  };
  const create = () =>
    operate({
      title: "创建用户",
      description: "创建当前服务器的本地 Matrix 账号。",
      fields: [
        {
          key: "localpart",
          label: "用户名",
          required: true,
          hint: "例如 alice，或完整 @alice:example.com",
        },
        { key: "displayname", label: "显示名称" },
        {
          key: "password",
          label: "初始密码",
          type: "password",
          required: true,
        },
        { key: "admin", label: "授予服务器管理员权限", type: "checkbox" },
      ],
      run: async (v) => {
        const id = userId(v.localpart, session);
        try {
          await admin("user", { user_id: id });
        } catch (e) {
          if (
            (e as { status?: number; code?: string }).status !== 404 ||
            (e as { code?: string }).code === "M_UNRECOGNIZED"
          )
            throw e;
          return admin(
            "saveUser",
            { user_id: id },
            {},
            {
              password: v.password,
              displayname: v.displayname,
              admin: v.admin,
            },
            true,
          );
        }
        throw new Error("用户已存在，请使用编辑功能，避免覆盖账号");
      },
      onDone: reload,
    });
  return (
    <>
      <PageTitle
        eyebrow="IDENTITY & ACCESS"
        title="用户管理"
        description="管理成员资料、访问权限和登录设备。"
      >
        <Button kind="primary" onClick={create}>
          <Plus size={17} />
          创建用户
        </Button>
      </PageTitle>
      <div className="directory-tabs" role="group" aria-label="用户分类">
        {[
          ["regular", "普通用户", result.data?.counts?.regular],
          ["bridges", "桥接用户", result.data?.counts?.bridges],
          ["all", "全部账号", result.data?.counts?.all],
        ].map(([key, label, count]) => (
          <button
            key={key}
            className={
              group === key ||
              (key === "bridges" && !["regular", "all"].includes(group))
                ? "active"
                : ""
            }
            onClick={() => switchGroup(key)}
          >
            {label}
            <span>{count ?? "—"}</span>
          </button>
        ))}
      </div>
      {!["regular", "all"].includes(group) && (
        <div className="bridge-tools">
          <p>
            根据 Signal UUID、Telegram 数字 ID
            或部署规则分类。请核对目标并先停止对应桥接，再清理账号和本地媒体。
          </p>
          <div className="actions">
            <Button
              disabled={!checked.length}
              onClick={() => setCleanup({ ids: checked })}
            >
              预览清理所选（{checked.length}）
            </Button>
            <Button
              kind="danger-soft"
              disabled={!result.data?.total}
              onClick={() => setCleanup({ all: true, filter: directoryFilter })}
            >
              预览清理此筛选的全部用户
            </Button>
          </div>
        </div>
      )}
      <Panel>
        <div className="table-heading">
          <div>
            <h2>
              {group === "regular"
                ? "成员目录"
                : group === "all"
                  ? "全部账号"
                  : "桥接成员目录"}
            </h2>
            <p>当前服务器上的用户与访问权限</p>
          </div>
          <Badge>
            {result.data?.total === undefined
              ? "正在读取"
              : `${result.data.total} 位用户`}
          </Badge>
        </div>
        <div className="toolbar">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
              setChecked([]);
            }}
          >
            <Search size={17} />
            <input
              aria-label="搜索用户"
              placeholder="搜索用户名或显示名称…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="submit">搜索</button>
          </form>
          <select
            aria-label="用户筛选"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setChecked([]);
            }}
          >
            <option value="all">全部状态（含停用）</option>
            <option value="active">未停用用户</option>
            <option value="admin">管理员</option>
          </select>
          {!["regular", "all"].includes(group) && (
            <select
              aria-label="桥接类型"
              value={group}
              onChange={(e) => switchGroup(e.target.value)}
            >
              <option value="bridges">全部桥接</option>
              {Object.entries(result.data?.groups || {}).map(
                ([name, count]) => (
                  <option key={name} value={name}>
                    {name}（{String(count)}）
                  </option>
                ),
              )}
            </select>
          )}
          <Refresh onClick={reload} />
        </div>
        <ErrorBox error={result.error} />
        {result.loading && !result.data ? (
          <Loading />
        ) : !result.data?.users?.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    {!["regular", "all"].includes(group) && (
                      <input
                        type="checkbox"
                        aria-label="选择已加载桥接用户"
                        checked={
                          Boolean(
                            result.data?.users?.some((u: Data) => !u.protected),
                          ) &&
                          result.data.users
                            .filter((u: Data) => !u.protected)
                            .every((u: Data) => checked.includes(u.name))
                        }
                        onChange={(e) =>
                          setChecked(
                            e.target.checked
                              ? result
                                  .data!.users.filter((u: Data) => !u.protected)
                                  .map((u: Data) => u.name)
                              : [],
                          )
                        }
                      />
                    )}{" "}
                    用户
                  </th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>最近在线</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.data.users.map((u: Data) => (
                  <tr key={u.name}>
                    <td>
                      <div className="user-select-row">
                        {!["regular", "all"].includes(group) && (
                          <input
                            type="checkbox"
                            aria-label={`选择 ${u.name}`}
                            disabled={u.protected}
                            checked={checked.includes(u.name)}
                            onChange={(e) =>
                              setChecked((v) =>
                                e.target.checked
                                  ? [...v, u.name]
                                  : v.filter((id) => id !== u.name),
                              )
                            }
                          />
                        )}
                        <button
                          className="identity"
                          onClick={() => setSelected(u.name)}
                        >
                          <Avatar
                            name={u.displayname || u.name}
                            mxc={u.avatar_url}
                            homeserver={session.homeserver}
                          />
                          <span>
                            <strong>
                              {u.displayname || u.name.split(":")[0].slice(1)}
                            </strong>
                            <small>{u.name}</small>
                          </span>
                        </button>
                      </div>
                    </td>
                    <td>
                      <Badge tone={u.admin ? "purple" : ""}>
                        {u.admin
                          ? "管理员"
                          : u.bridge
                            ? u.bridge.name
                            : "普通用户"}
                      </Badge>
                    </td>
                    <td>
                      <Status user={u} />
                    </td>
                    <td className="muted">{fmtDate(u.last_seen_ts)}</td>
                    <td>
                      <Button kind="text" onClick={() => setSelected(u.name)}>
                        管理
                        <ChevronRight size={15} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <InfiniteEnd
          list={result}
          count={result.data?.users?.length || 0}
          total={result.data?.total}
        />
      </Panel>
      <BridgeJobs onRetry={(ids) => setCleanup({ ids })} />
      {cleanup && (
        <BridgeCleanup
          selection={cleanup}
          session={session}
          onClose={() => setCleanup(null)}
          onStarted={() => {
            setCleanup(null);
            reload();
          }}
        />
      )}
      <p className="footnote">
        用户 ID 保留在 Matrix
        网络中。停用并擦除不会物理删除账号标识或其他服务器上的副本。
      </p>
      {selected && (
        <UserDetail
          id={selected}
          session={session}
          operate={operate}
          onClose={() => {
            setSelected("");
            reload();
          }}
        />
      )}
    </>
  );
}

function UserDetail({
  id,
  session,
  operate,
  onClose,
}: {
  id: string;
  session: Session;
  operate: Operate;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("profile"),
    [from, setFrom] = useState(0),
    [mediaCleanup, setMediaCleanup] = useState(false);
  const detail = useLoad(() => admin("user", { user_id: id }), [id]);
  const tabs = [
    ["profile", "基本信息"],
    ["userRooms", "加入房间"],
    ["devices", "设备"],
    ["userMedia", "媒体"],
    ["whois", "连接信息"],
    ["memberships", "成员关系"],
    ["accountData", "账户数据"],
  ];
  const info = useLoad(
    () =>
      tab === "profile"
        ? Promise.resolve(null)
        : tab === "userRooms"
          ? request("/user-rooms", "POST", { user_id: id, from })
          : admin(tab, { user_id: id }, { from, limit: 20 }),
    [id, tab, from],
  );
  const observation = useLoad(() => request("/observability"), [id]);
  const creation = observation.data?.snapshot?.registrations?.accounts?.find(
    (v: Data) => v.user_id === id,
  );
  const u = detail.data || {};
  const action = (
    title: string,
    endpoint: string,
    body: Data,
    danger = false,
  ) =>
    operate({
      title,
      description: id,
      danger,
      run: () => admin(endpoint, { user_id: id }, {}, body, true),
      onDone: detail.reload,
    });
  return (
    <>
      <Modal title="用户详情" wide onClose={onClose}>
        <div className="modal-body">
          <div className="detail-heading">
            <Avatar
              name={u.displayname || id}
              mxc={u.avatar_url}
              homeserver={session.homeserver}
              large
            />
            <div>
              <h2>{u.displayname || id.split(":")[0].slice(1)}</h2>
              <code>{id}</code>
            </div>
            <Status user={u} />
          </div>
          <div className="tabs">
            {tabs.map(([key, name]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => {
                  setTab(key);
                  setFrom(0);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <ErrorBox error={detail.error || info.error} />
          {tab === "profile" ? (
            detail.loading ? (
              <Loading />
            ) : (
              <>
                <div className="detail-grid">
                  <div>
                    <small>服务器角色</small>
                    <strong>{u.admin ? "管理员" : "普通用户"}</strong>
                  </div>
                  <div>
                    <small>最近在线</small>
                    <strong>{fmtDate(u.last_seen_ts)}</strong>
                  </div>
                  <div>
                    <small>暂停状态</small>
                    <strong>{u.suspended ? "已暂停" : "未暂停"}</strong>
                  </div>
                  <div>
                    <small>资料擦除</small>
                    <strong>{u.erased ? "已标记擦除" : "未擦除"}</strong>
                  </div>
                </div>
                <div className="creation-source">
                  <small>账号创建来源 IP</small>
                  <strong>{creation?.ip || "暂无可核实的注册记录"}</strong>
                  <span>
                    {creation
                      ? fmtDate(creation.at)
                      : "需接入含用户 ID 的成功注册审计日志；最近登录 IP 不能替代创建 IP。"}
                  </span>
                </div>
                <h3>账号与安全</h3>
                <div className="action-grid">
                  <Button
                    onClick={() =>
                      operate({
                        title: "编辑用户资料",
                        fields: [
                          {
                            key: "displayname",
                            label: "显示名称",
                            value: u.displayname || "",
                          },
                          {
                            key: "avatar_url",
                            label: "头像 MXC 地址",
                            value: u.avatar_url || "",
                          },
                          {
                            key: "admin",
                            label: "服务器管理员",
                            type: "checkbox",
                            value: Boolean(u.admin),
                          },
                        ],
                        run: (v) =>
                          admin("saveUser", { user_id: id }, {}, v, true),
                        onDone: detail.reload,
                      })
                    }
                  >
                    <ShieldCheck size={16} />
                    资料与权限
                  </Button>
                  <Button
                    onClick={() =>
                      operate({
                        title: "重置密码",
                        description: "MAS 模式请在外部认证服务中修改密码。",
                        fields: [
                          {
                            key: "new_password",
                            label: "新密码",
                            type: "password",
                            required: true,
                          },
                          {
                            key: "logout_devices",
                            label: "注销用户的所有设备",
                            type: "checkbox",
                            value: true,
                          },
                        ],
                        run: (v) =>
                          admin("password", { user_id: id }, {}, v, true),
                        onDone: detail.reload,
                      })
                    }
                  >
                    <KeyRound size={16} />
                    修改密码
                  </Button>
                  <Button
                    disabled={id === session.userId}
                    onClick={() =>
                      action(
                        u.locked ? "解除锁定" : "锁定账号",
                        "saveUser",
                        { locked: !u.locked },
                        !u.locked,
                      )
                    }
                  >
                    <LockKeyhole size={16} />
                    {u.locked ? "解除锁定" : "锁定账号"}
                  </Button>
                  <Button
                    disabled={id === session.userId}
                    onClick={() =>
                      action(
                        u.suspended ? "恢复发送权限" : "暂停用户",
                        "suspend",
                        { suspend: !u.suspended },
                        !u.suspended,
                      )
                    }
                  >
                    {u.suspended ? "恢复发送权限" : "暂停用户"}
                  </Button>
                  {u.deactivated ? (
                    <Button
                      onClick={() =>
                        operate({
                          title: "重新启用用户",
                          fields: [
                            {
                              key: "password",
                              label: "新密码",
                              type: "password",
                              required: true,
                            },
                          ],
                          run: (v) =>
                            admin(
                              "saveUser",
                              { user_id: id },
                              {},
                              { ...v, deactivated: false },
                              true,
                            ),
                          onDone: detail.reload,
                        })
                      }
                    >
                      重新启用
                    </Button>
                  ) : (
                    <Button
                      kind="danger-soft"
                      disabled={id === session.userId}
                      onClick={() =>
                        action("停用用户", "deactivate", { erase: false }, true)
                      }
                    >
                      停用用户
                    </Button>
                  )}
                  <Button
                    kind="danger-soft"
                    disabled={id === session.userId}
                    onClick={() =>
                      operate({
                        title: "停用并擦除用户资料",
                        description: `将停用 ${id}、注销设备并执行 Tuwunel 的 erase 流程。此操作不会物理删除 Matrix ID。`,
                        danger: true,
                        run: () =>
                          admin(
                            "deactivate",
                            { user_id: id },
                            {},
                            { erase: true },
                            true,
                          ),
                        onDone: detail.reload,
                      })
                    }
                  >
                    <Trash2 size={15} />
                    停用并擦除
                  </Button>
                </div>
                <details className="raw">
                  <summary>查看完整账户数据</summary>
                  <JsonView value={u} />
                </details>
              </>
            )
          ) : info.loading ? (
            <Loading />
          ) : tab === "userRooms" ? (
            <>
              {info.data?.rooms?.length ? (
                info.data.rooms.map((room: Data) => (
                  <div className="user-room-row" key={room.room_id}>
                    <Avatar
                      name={room.name || "房间"}
                      mxc={room.avatar}
                      homeserver={session.homeserver}
                    />
                    <div>
                      <strong>
                        {room.name ||
                          (room.error ? "房间资料暂不可用" : "未命名房间")}
                      </strong>
                      <code>{room.room_id}</code>
                      {room.canonical_alias && (
                        <small>{room.canonical_alias}</small>
                      )}
                      {room.error && (
                        <small className="room-error">{room.error}</small>
                      )}
                    </div>
                    {room.joined_members !== undefined && (
                      <Badge>{room.joined_members} 位成员</Badge>
                    )}
                  </div>
                ))
              ) : (
                <Empty text="该用户未加入房间" />
              )}
              <Pagination
                from={from}
                next={info.data?.next_token}
                total={info.data?.total}
                onChange={setFrom}
              />
            </>
          ) : tab === "devices" ? (
            <>
              {info.data?.devices?.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>设备</th>
                        <th>最后连接</th>
                        <th>IP</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.data.devices.map((d: Data) => (
                        <tr key={d.device_id}>
                          <td>
                            <strong>{d.display_name || "未命名设备"}</strong>
                            <small>{d.device_id}</small>
                          </td>
                          <td>{fmtDate(d.last_seen_ts)}</td>
                          <td>{d.last_seen_ip || "—"}</td>
                          <td>
                            <div className="actions">
                              <Button
                                kind="text"
                                onClick={() =>
                                  operate({
                                    title: "重命名设备",
                                    fields: [
                                      {
                                        key: "display_name",
                                        label: "名称",
                                        value: d.display_name || "",
                                      },
                                    ],
                                    run: (v) =>
                                      admin(
                                        "saveDevice",
                                        { user_id: id, device_id: d.device_id },
                                        {},
                                        v,
                                        true,
                                      ),
                                    onDone: info.reload,
                                  })
                                }
                              >
                                改名
                              </Button>
                              <Button
                                kind="danger-soft"
                                onClick={() =>
                                  operate({
                                    title: "删除设备",
                                    description: `将注销设备 ${d.device_id}。`,
                                    danger: true,
                                    run: () =>
                                      admin(
                                        "deleteDevice",
                                        { user_id: id, device_id: d.device_id },
                                        {},
                                        {},
                                        true,
                                      ),
                                    onDone: info.reload,
                                  })
                                }
                              >
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty text="暂无设备" />
              )}
            </>
          ) : tab === "userMedia" ? (
            <>
              <div className="section-actions">
                <Button
                  kind="danger-soft"
                  onClick={() => setMediaCleanup(true)}
                >
                  <Trash2 size={15} />
                  清理此用户全部媒体
                </Button>
              </div>
              {info.data?.media?.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>媒体</th>
                        <th>大小</th>
                        <th>创建时间</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.data.media.map((m: Data) => (
                        <tr key={m.media_id}>
                          <td>
                            <strong>{m.upload_name || m.media_id}</strong>
                            <small>{m.media_type}</small>
                          </td>
                          <td>{bytes(m.media_length)}</td>
                          <td>{fmtDate(m.created_ts)}</td>
                          <td>
                            <Button
                              kind="danger-soft"
                              onClick={() =>
                                operate({
                                  title: "删除媒体",
                                  description: m.media_id,
                                  danger: true,
                                  run: () =>
                                    admin(
                                      "deleteMedia",
                                      {
                                        server_name: id.slice(
                                          id.indexOf(":") + 1,
                                        ),
                                        media_id: m.media_id,
                                      },
                                      {},
                                      {},
                                      true,
                                    ),
                                  onDone: info.reload,
                                })
                              }
                            >
                              删除
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty />
              )}
              <Pagination
                from={from}
                next={info.data?.next_token}
                total={info.data?.total}
                onChange={setFrom}
              />
            </>
          ) : (
            info.data && <JsonView value={info.data} />
          )}
        </div>
        <div className="modal-foot">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </Modal>
      {mediaCleanup && (
        <MediaCleanup
          users={[
            {
              user_id: id,
              displayname: u.displayname,
              media_count: info.data?.total,
            },
          ]}
          onClose={() => setMediaCleanup(false)}
          onStarted={() => {
            setMediaCleanup(false);
            onClose();
            location.hash = "media";
          }}
        />
      )}
    </>
  );
}

export function RoomsPage({
  operate,
  session,
}: {
  operate: Operate;
  session: Session;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState("");
  const result = useInfinite(
    (from) => request("/rooms", "POST", { from, search: query }),
    "rooms",
    "next_batch",
    "room_id",
    [query],
  );
  return (
    <>
      <PageTitle
        eyebrow="CONVERSATIONS"
        title="房间管理"
        description="查看房间成员、状态与媒体，维护服务器上的会话空间。"
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
            }}
          >
            <Search size={17} />
            <input
              aria-label="搜索房间"
              placeholder="搜索名称、别名或完整房间 ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="submit">搜索</button>
          </form>
          <Badge>连续滚动 · 按名称排序</Badge>
        </div>
        <ErrorBox error={result.error} />
        {result.loading && !result.data ? (
          <Loading />
        ) : !result.data?.rooms?.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>房间</th>
                  <th>成员 / 本地</th>
                  <th>可见性</th>
                  <th>加密</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.data.rooms.map((r: Data) => (
                  <tr key={r.room_id}>
                    <td>
                      <button
                        className="identity"
                        onClick={() => setSelected(r.room_id)}
                      >
                        <Avatar
                          name={r.name || "房间"}
                          mxc={r.avatar}
                          homeserver={session.homeserver}
                        />
                        <span>
                          <strong>{r.name || "未命名房间"}</strong>
                          <small>{r.room_id}</small>
                          {r.canonical_alias && (
                            <small>{r.canonical_alias}</small>
                          )}
                        </span>
                      </button>
                    </td>
                    <td>
                      {r.joined_members}{" "}
                      <span className="muted">/ {r.joined_local_members}</span>
                    </td>
                    <td>
                      <Badge>{r.public ? "公开" : "私密"}</Badge>
                    </td>
                    <td>
                      {r.encryption ? (
                        <Badge tone="green">
                          <LockKeyhole size={11} />
                          已加密
                        </Badge>
                      ) : (
                        <span className="muted">未加密</span>
                      )}
                    </td>
                    <td>
                      <Button
                        kind="text"
                        onClick={() => setSelected(r.room_id)}
                      >
                        查看
                        <ArrowUpRight size={15} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <InfiniteEnd
          list={result}
          count={result.data?.rooms?.length || 0}
          total={result.data?.total_rooms}
        />
      </Panel>
      <p className="footnote">
        端到端加密由客户端持有密钥。管理系统不能解密房间消息。
      </p>
      {selected && (
        <RoomDetail
          id={selected}
          operate={operate}
          onClose={() => {
            setSelected("");
            result.reload();
          }}
        />
      )}
    </>
  );
}
function RoomDetail({
  id,
  operate,
  onClose,
}: {
  id: string;
  operate: Operate;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("room"),
    [cursor, setCursor] = useState("");
  const data = useLoad(
    () =>
      admin(
        tab,
        { room_id: id },
        tab === "roomMessages" ? { dir: "b", limit: 20, from: cursor } : {},
      ),
    [id, tab, cursor],
  );
  const action = (
    title: string,
    endpoint: string,
    body: Data,
    danger = false,
  ) =>
    operate({
      title,
      description: id,
      danger,
      run: () => admin(endpoint, { room_id: id }, {}, body, true),
      showResult: true,
      onDone: data.reload,
    });
  return (
    <Modal title="房间详情" wide onClose={onClose}>
      <div className="modal-body">
        <code className="break">{id}</code>
        <div className="tabs">
          {[
            ["room", "概览"],
            ["roomMembers", "成员"],
            ["roomState", "状态"],
            ["roomMessages", "事件"],
            ["roomMedia", "媒体"],
            ["roomBlock", "封禁状态"],
          ].map(([key, name]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => {
                setTab(key);
                setCursor("");
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <ErrorBox error={data.error} />
        {data.loading ? (
          <Loading />
        ) : (
          data.data && <JsonView value={data.data} />
        )}
        {tab === "roomMessages" &&
          data.data?.end &&
          data.data?.chunk?.length > 0 && (
            <Button onClick={() => setCursor(data.data.end)}>
              加载更早事件
            </Button>
          )}
        <h3>房间操作</h3>
        <div className="action-grid">
          <Button
            onClick={() =>
              operate({
                title: "将用户加入房间",
                fields: [
                  {
                    key: "user_id",
                    label: "本地用户 Matrix ID",
                    required: true,
                  },
                ],
                run: (v) =>
                  admin("joinRoom", { room_id_or_alias: id }, {}, v, true),
                showResult: true,
              })
            }
          >
            加入成员
          </Button>
          <Button
            onClick={() =>
              operate({
                title: "授予房间管理员权限",
                fields: [
                  { key: "user_id", label: "用户 Matrix ID", required: true },
                ],
                run: (v) =>
                  admin("makeRoomAdmin", { room_id: id }, {}, v, true),
                showResult: true,
              })
            }
          >
            设置管理员
          </Button>
          <Button
            onClick={() =>
              action("封禁房间", "blockRoom", { block: true }, true)
            }
          >
            封禁房间
          </Button>
          <Button
            onClick={() =>
              action("解除房间封禁", "blockRoom", { block: false })
            }
          >
            解除封禁
          </Button>
          <Button
            kind="danger-soft"
            onClick={() =>
              operate({
                title: "清理房间历史",
                description: "删除指定时间之前的历史，结果以后台任务状态为准。",
                danger: true,
                fields: [
                  {
                    key: "before",
                    label: "截止时间",
                    type: "datetime-local",
                    required: true,
                  },
                  {
                    key: "delete_local_events",
                    label: "同时删除本地事件",
                    type: "checkbox",
                  },
                ],
                run: (v) =>
                  admin(
                    "purgeHistory",
                    { room_id: id },
                    {},
                    {
                      purge_up_to_ts: new Date(v.before).getTime(),
                      delete_local_events: v.delete_local_events,
                    },
                    true,
                  ),
                showResult: true,
              })
            }
          >
            清理历史
          </Button>
          <Button
            kind="danger-soft"
            onClick={() =>
              action(
                "删除房间（后台任务）",
                "deleteRoomAsync",
                { block: true, purge: true },
                true,
              )
            }
          >
            <Trash2 size={15} />
            删除房间
          </Button>
        </div>
        <p className="footnote">
          异步操作返回任务 ID 后，请在「后台任务」查看最终结果。
        </p>
      </div>
      <div className="modal-foot">
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Modal>
  );
}
