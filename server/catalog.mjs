// Verified against matrix-construct/tuwunel @ 2a0ae4be (2026-11-17).
// Keeping one catalog for the UI and the proxy prevents arbitrary upstream requests.
const entries = [];
function add(group, id, label, method, path, query = {}, body, note = "") {
  entries.push({
    group,
    id,
    label,
    method,
    path: path.startsWith("/_matrix/") ? path : "/_synapse/admin/" + path,
    query,
    ...(body === undefined ? {} : { body }),
    note,
  });
}
const U = "用户",
  R = "房间",
  M = "媒体",
  D = "设备",
  T = "注册令牌",
  F = "联邦",
  S = "服务器";
add(U, "users", "用户列表", "GET", "v2/users", {
  from: 0,
  limit: 20,
  deactivated: true,
  locked: true,
  name: "",
});
add(U, "usersV3", "用户列表（v3）", "GET", "v3/users", {
  from: 0,
  limit: 20,
  locked: true,
});
add(U, "user", "用户详情", "GET", "v2/users/{user_id}");
add(
  U,
  "saveUser",
  "创建 / 修改用户",
  "PUT",
  "v2/users/{user_id}",
  {},
  { displayname: "", admin: false },
  "不支持的 user_type、external_ids、approved 字段会被上游忽略。",
);
add(
  U,
  "deactivate",
  "停用 / 擦除用户",
  "POST",
  "v1/deactivate/{user_id}",
  {},
  { erase: false },
  "erase=true 会标记擦除并清理资料；不是物理删除 Matrix ID，也不会撤回远端副本。",
);
add(
  U,
  "password",
  "重置密码",
  "POST",
  "v1/reset_password/{user_id}",
  {},
  { new_password: "", logout_devices: true },
  "MAS 模式不提供此端点。",
);
add(
  U,
  "isAdmin",
  "查询管理员权限",
  "GET",
  "v1/users/{user_id}/admin",
  {},
  undefined,
  "MAS 模式不提供此端点。修改权限请使用创建 / 修改用户。",
);
add(U, "userRooms", "已加入房间", "GET", "v1/users/{user_id}/joined_rooms");
add(U, "memberships", "房间成员关系", "GET", "v1/users/{user_id}/memberships");
add(U, "pushers", "推送配置", "GET", "v1/users/{user_id}/pushers");
add(U, "accountData", "账户数据", "GET", "v1/users/{user_id}/accountdata");
add(U, "whois", "登录连接信息", "GET", "v1/whois/{user_id}");
add(
  U,
  "suspend",
  "暂停 / 恢复用户",
  "PUT",
  "v1/suspend/{user_id}",
  {},
  { suspend: true },
);
add(
  U,
  "loginAs",
  "生成用户访问令牌",
  "POST",
  "v1/users/{user_id}/login",
  {},
  {},
  "敏感操作：返回可代用户操作的令牌。MAS 模式不可用。请勿分享结果。",
);
add(
  U,
  "redactUser",
  "批量撤回用户事件",
  "POST",
  "v1/user/{user_id}/redact",
  {},
  { rooms: [], reason: "Administrator moderation" },
  "异步任务；rooms 为空会撤回用户在所有已加入或被封禁房间中的事件，请谨慎指定范围。",
);
add(
  U,
  "redactStatus",
  "撤回任务状态",
  "GET",
  "v1/user/redact_status/{redact_id}",
);
add(
  U,
  "crossSigning",
  "允许替换交叉签名密钥",
  "POST",
  "v1/users/{user_id}/_allow_cross_signing_replacement_without_uia",
  {},
  {},
  "临时放开交互认证限制，请确认用户身份。",
);
add(
  U,
  "threepid",
  "通过邮箱查询用户",
  "GET",
  "v1/threepid/{medium}/users/{address}",
);
add(U, "username", "用户名可用性", "GET", "v1/username_available", {
  username: "",
});
add(
  U,
  "nonce",
  "获取共享密钥注册 nonce",
  "GET",
  "v1/register",
  {},
  undefined,
  "注册表单使用管理员创建用户，无需共享密钥。此端点供已有 HMAC 注册流程使用。MAS 模式不可用。",
);
add(
  U,
  "register",
  "共享密钥 HMAC 注册",
  "POST",
  "v1/register",
  {},
  { nonce: "", username: "", password: "", admin: false, mac: "" },
  "需要在外部安全计算 HMAC；不要将 registration_shared_secret 填入系统。MAS 模式不可用。",
);
add(D, "devices", "用户设备", "GET", "v2/users/{user_id}/devices");
add(
  D,
  "createDevice",
  "创建设备",
  "POST",
  "v2/users/{user_id}/devices",
  {},
  { device_id: "" },
);
add(D, "device", "设备详情", "GET", "v2/users/{user_id}/devices/{device_id}");
add(
  D,
  "saveDevice",
  "重命名设备",
  "PUT",
  "v2/users/{user_id}/devices/{device_id}",
  {},
  { display_name: "" },
);
add(
  D,
  "deleteDevice",
  "删除设备",
  "DELETE",
  "v2/users/{user_id}/devices/{device_id}",
  {},
  {},
);
add(
  D,
  "deleteDevices",
  "批量删除设备",
  "POST",
  "v2/users/{user_id}/delete_devices",
  {},
  { devices: [] },
);
add(T, "tokens", "注册令牌列表", "GET", "v1/registration_tokens");
add(
  T,
  "createToken",
  "创建注册令牌",
  "POST",
  "v1/registration_tokens/new",
  {},
  { length: 24, uses_allowed: 1, expiry_time: null },
);
add(T, "token", "注册令牌详情", "GET", "v1/registration_tokens/{token}");
add(
  T,
  "saveToken",
  "修改注册令牌",
  "PUT",
  "v1/registration_tokens/{token}",
  {},
  { uses_allowed: null, expiry_time: null },
);
add(
  T,
  "deleteToken",
  "删除注册令牌",
  "DELETE",
  "v1/registration_tokens/{token}",
  {},
  {},
);
add(R, "rooms", "房间列表", "GET", "v1/rooms", {
  from: 0,
  limit: 20,
  search_term: "",
  order_by: "joined_members",
  dir: "b",
});
add(R, "room", "房间详情", "GET", "v1/rooms/{room_id}");
add(
  R,
  "deleteRoom",
  "删除房间（同步）",
  "DELETE",
  "v1/rooms/{room_id}",
  {},
  { block: true, purge: true },
  "移出本地成员并清理本地存储，不会删除其他服务器的副本。",
);
add(R, "roomMembers", "房间成员", "GET", "v1/rooms/{room_id}/members");
add(R, "roomState", "房间状态", "GET", "v1/rooms/{room_id}/state");
add(
  R,
  "roomMessages",
  "房间事件",
  "GET",
  "v1/rooms/{room_id}/messages",
  { dir: "b", limit: 20 },
  undefined,
  "端到端加密事件仅返回密文，本系统不能解密。",
);
add(
  R,
  "context",
  "事件上下文",
  "GET",
  "v1/rooms/{room_id}/context/{event_id}",
  { limit: 10 },
);
add(
  R,
  "timestampEvent",
  "按时间定位事件",
  "GET",
  "v1/rooms/{room_id}/timestamp_to_event",
  { ts: 0, dir: "b" },
);
add(
  R,
  "hierarchy",
  "空间层级",
  "GET",
  "v1/rooms/{room_id}/hierarchy",
  { limit: 20 },
  undefined,
  "仅本地已知房间。",
);
add(R, "roomBlock", "封禁状态", "GET", "v1/rooms/{room_id}/block");
add(
  R,
  "blockRoom",
  "设置房间封禁",
  "PUT",
  "v1/rooms/{room_id}/block",
  {},
  { block: true },
);
add(
  R,
  "makeRoomAdmin",
  "设置房间管理员",
  "POST",
  "v1/rooms/{room_id}/make_room_admin",
  {},
  { user_id: "" },
);
add(
  R,
  "extremities",
  "房间前向极值",
  "GET",
  "v1/rooms/{room_id}/forward_extremities",
);
add(
  R,
  "deleteExtremities",
  "清理前向极值",
  "DELETE",
  "v1/rooms/{room_id}/forward_extremities",
  {},
  {},
);
add(
  R,
  "deleteRoomAsync",
  "删除房间（异步）",
  "DELETE",
  "v2/rooms/{room_id}",
  {},
  { block: true, purge: true },
);
add(
  R,
  "deleteStatus",
  "删除任务状态",
  "GET",
  "v2/rooms/delete_status/{delete_id}",
);
add(
  R,
  "roomDeleteStatus",
  "房间删除任务",
  "GET",
  "v2/rooms/{room_id}/delete_status",
);
add(
  R,
  "joinRoom",
  "将用户加入房间",
  "POST",
  "v1/join/{room_id_or_alias}",
  {},
  { user_id: "" },
);
add(
  R,
  "purgeHistory",
  "清理房间历史",
  "POST",
  "v1/purge_history/{room_id}",
  {},
  { purge_up_to_ts: 0, delete_local_events: false },
);
add(
  R,
  "purgeStatus",
  "历史清理状态",
  "GET",
  "v1/purge_history_status/{purge_id}",
);
add(M, "media", "媒体元数据", "GET", "v1/media/{server_name}/{media_id}");
add(
  M,
  "deleteMedia",
  "删除单个本地媒体",
  "DELETE",
  "v1/media/{server_name}/{media_id}",
  {},
  {},
);
add(
  M,
  "deleteOldMedia",
  "按时间与大小删除媒体",
  "POST",
  "v1/media/delete",
  { before_ts: 0, size_gt: 0, keep_profiles: true },
  {},
  "时间按文件修改时间计算。默认保留头像。此 API 没有 dry-run；调用会立即删除。",
);
add(
  M,
  "purgeRemote",
  "清理远程媒体缓存",
  "POST",
  "v1/purge_media_cache",
  { before_ts: 0 },
  {},
  "按文件修改时间，非最后访问时间。删除后可能从远程重新下载。",
);
add(M, "userMedia", "用户媒体列表", "GET", "v1/users/{user_id}/media", {
  from: 0,
  limit: 20,
});
add(
  M,
  "deleteUserMedia",
  "删除一页用户媒体",
  "DELETE",
  "v1/users/{user_id}/media",
  { from: 0, limit: 100 },
  {},
  "每次仅删除一页。继续删除应保持 from=0，因为剩余数据会重新排序。",
);
add(
  M,
  "roomMedia",
  "房间引用媒体",
  "GET",
  "v1/room/{room_id}/media",
  {},
  undefined,
  "只包含未加密事件中的媒体引用。",
);
add(M, "mediaStats", "用户媒体统计", "GET", "v1/statistics/users/media", {
  from: 0,
  limit: 20,
  order_by: "media_length",
  dir: "b",
});
add(F, "destinations", "联邦目标", "GET", "v1/federation/destinations", {
  from: 0,
  limit: 20,
});
add(
  F,
  "destination",
  "联邦目标详情",
  "GET",
  "v1/federation/destinations/{destination}",
);
add(
  F,
  "destinationRooms",
  "共享房间",
  "GET",
  "v1/federation/destinations/{destination}/rooms",
  { from: 0, limit: 20 },
);
add(
  F,
  "resetConnection",
  "重试联邦连接",
  "POST",
  "v1/federation/destinations/{destination}/reset_connection",
  {},
  {},
);
add(S, "version", "服务器版本", "GET", "v1/server_version");
add(
  S,
  "notice",
  "发送服务器通知",
  "POST",
  "v1/send_server_notice",
  {},
  { user_id: "", content: { msgtype: "m.text", body: "" } },
);
add(
  S,
  "noticeTxn",
  "发送幂等服务器通知",
  "PUT",
  "v1/send_server_notice/{txn_id}",
  {},
  { user_id: "", content: { msgtype: "m.text", body: "" } },
);
add(S, "tasks", "后台任务", "GET", "v1/scheduled_tasks");
add(S, "event", "获取原始事件", "GET", "v1/fetch_event/{event_id}");
add(
  U,
  "nativeLocked",
  "原生账号锁定状态",
  "GET",
  "/_matrix/client/v1/admin/lock/{user_id}",
);
add(
  U,
  "nativeLock",
  "原生锁定 / 解锁账号",
  "PUT",
  "/_matrix/client/v1/admin/lock/{user_id}",
  {},
  { locked: true },
);
add(
  U,
  "nativeSuspended",
  "原生账号暂停状态",
  "GET",
  "/_matrix/client/v1/admin/suspend/{user_id}",
);
add(
  U,
  "nativeSuspend",
  "原生暂停 / 恢复账号",
  "PUT",
  "/_matrix/client/v1/admin/suspend/{user_id}",
  {},
  { suspended: true },
);
export const catalog = Object.freeze(entries);
export const byId = new Map(catalog.map((entry) => [entry.id, entry]));

export function buildRequest(id, params = {}, query = {}, body) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    (body !== undefined &&
      (!body || typeof body !== "object" || Array.isArray(body)))
  )
    throw Object.assign(new Error("参数与正文必须是 JSON 对象"), {
      status: 400,
    });
  const endpoint = byId.get(id);
  if (!endpoint)
    throw Object.assign(new Error("未允许的管理 API"), { status: 400 });
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 1024 ||
      /[\x00-\x1f/\\%]/.test(value) ||
      value === "." ||
      value === ".."
    ) {
      throw Object.assign(new Error(`无效路径参数：${key}`), { status: 400 });
    }
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (/token|password|secret|authorization/i.test(key))
      throw Object.assign(new Error("查询参数不能包含凭据"), { status: 400 });
    if (value !== "" && value !== null && value !== undefined) {
      if (!["string", "number", "boolean"].includes(typeof value))
        throw Object.assign(new Error("查询参数必须为标量"), { status: 400 });
      search.set(key, String(value));
    }
  }
  return {
    endpoint,
    path: path + (search.size ? "?" + search : ""),
    method: endpoint.method,
    body: endpoint.method === "GET" ? undefined : (body ?? {}),
  };
}
