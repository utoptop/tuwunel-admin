export class HttpError extends Error {
  constructor(status, message, code = "M_UNKNOWN") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeHomeserver(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "请配置有效的 MATRIX_HOMESERVER_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new HttpError(
      400,
      "服务器地址必须是 HTTP(S) origin，不能包含路径、凭据或查询参数",
    );
  }
  return url.origin;
}

export async function matrix(base, token, method, path, body) {
  let response;
  try {
    response = await fetch(base + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new HttpError(
      502,
      "无法连接 Matrix 服务器，或请求超时；请检查地址、TLS 和网络",
    );
  }
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024)
      throw new HttpError(502, "上游响应超过 8 MiB，请缩小分页大小");
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(502, "上游没有返回 JSON，请检查反向代理配置");
  }
  if (!response.ok) {
    const unsupported =
      response.status === 404 && data.errcode === "M_UNRECOGNIZED";
    throw new HttpError(
      response.status,
      unsupported
        ? "当前 Tuwunel 版本或认证模式不支持此 API（M_UNRECOGNIZED）"
        : String(data.error || `上游错误 ${response.status}`).slice(0, 500),
      data.errcode,
    );
  }
  return data;
}

export async function verifyAdmin(base, token) {
  if (
    typeof token !== "string" ||
    !token ||
    token.length > 8192 ||
    /[\r\n]/.test(token)
  )
    throw new HttpError(400, "访问令牌无效");
  const who = await matrix(
    base,
    token,
    "GET",
    "/_matrix/client/v3/account/whoami",
  );
  const details = await matrix(
    base,
    token,
    "GET",
    "/_synapse/admin/v2/users/" + encodeURIComponent(who.user_id),
  );
  if (details.admin !== true && details.admin !== 1)
    throw new HttpError(403, "此账号不是服务器管理员");
  return who.user_id;
}
