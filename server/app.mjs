import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { catalog, buildRequest } from "./catalog.mjs";
import {
  HttpError,
  matrix,
  normalizeHomeserver,
  verifyAdmin,
} from "./matrix.mjs";
import { Store } from "./store.mjs";
import { PolicyRunner, validatePolicy } from "./policy.mjs";

const SESSION_AGE = 12 * 3600000;
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
async function json(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json"))
    throw new HttpError(415, "请求必须使用 application/json");
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new HttpError(413, "请求体过大");
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || Array.isArray(data) || typeof data !== "object") throw 0;
    return data;
  } catch {
    throw new HttpError(400, "无效的 JSON 对象");
  }
}

export function createApp(config = {}) {
  const homeserver = config.homeserver
    ? normalizeHomeserver(config.homeserver)
    : "";
  const publicOrigin = config.publicUrl
    ? new URL(config.publicUrl).origin
    : null;
  const store = new Store(config.dataDir || "./data", config.encryptionKey);
  const runner = new PolicyRunner(store, homeserver);
  const sessions = new Map(),
    attempts = new Map();
  const staticDir = resolve(config.staticDir || "dist");
  const cookie = (value, maxAge = SESSION_AGE / 1000) =>
    `ta_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? "; Secure" : ""}`;
  async function adminSession(req) {
    const sid = /(?:^|;\s*)ta_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
    const session = sessions.get(sid);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(sid);
      throw new HttpError(401, "会话已过期，请重新登录");
    }
    if (Date.now() - session.verified > 60000) {
      try {
        await verifyAdmin(homeserver, session.token);
        session.verified = Date.now();
      } catch (error) {
        if ([401, 403].includes(error.status)) sessions.delete(sid);
        throw error;
      }
    }
    return { sid, session };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/api/health" && req.method === "GET")
        return send(res, 200, { status: "ok", version: "1.0.0" });
      if (path === "/api/config" && req.method === "GET")
        return send(res, 200, {
          homeserver,
          configured: Boolean(homeserver),
          version: "1.0.0",
        });
      if (path.startsWith("/api/")) {
        if (!["GET", "POST", "PUT", "DELETE"].includes(req.method))
          throw new HttpError(405, "不支持的请求方法");
        if (req.method !== "GET") {
          const expected =
            publicOrigin ||
            `${config.secureCookie ? "https" : "http"}://${req.headers.host}`;
          if (req.headers.origin !== expected)
            throw new HttpError(403, "请求来源不匹配，请检查 PUBLIC_URL 配置");
        }
        if (path === "/api/login" && req.method === "POST") {
          if (!homeserver)
            throw new HttpError(
              503,
              "请先设置 MATRIX_HOMESERVER_URL 环境变量并重启",
            );
          const addr = req.socket.remoteAddress;
          const now = Date.now();
          const recent = (attempts.get(addr) || []).filter(
            (time) => now - time < 600000,
          );
          if (recent.length >= 10)
            throw new HttpError(429, "登录尝试过多，请十分钟后再试");
          attempts.set(addr, [...recent, now]);
          const input = await json(req);
          let token = input.accessToken,
            owned = false;
          if (!token) {
            if (
              typeof input.username !== "string" ||
              typeof input.password !== "string" ||
              !input.username ||
              !input.password
            )
              throw new HttpError(400, "请输入管理员账号和密码");
            const login = await matrix(
              homeserver,
              null,
              "POST",
              "/_matrix/client/v3/login",
              {
                type: "m.login.password",
                identifier: { type: "m.id.user", user: input.username },
                password: input.password,
                initial_device_display_name: "Tuwunel Admin",
              },
            );
            token = login.access_token;
            owned = true;
          }
          let userId;
          try {
            userId = await verifyAdmin(homeserver, token);
          } catch (error) {
            if (owned)
              await matrix(
                homeserver,
                token,
                "POST",
                "/_matrix/client/v3/logout",
                {},
              ).catch(() => {});
            store.audit("anonymous", "登录验证失败", "", "failed");
            throw error;
          }
          const sid = randomBytes(32).toString("hex");
          const session = {
            token,
            owned,
            userId,
            csrf: randomBytes(24).toString("hex"),
            expires: Date.now() + SESSION_AGE,
            verified: Date.now(),
          };
          sessions.set(sid, session);
          attempts.delete(addr);
          store.audit(userId, "管理员登录");
          res.setHeader("Set-Cookie", cookie(sid));
          return send(res, 200, {
            userId,
            csrf: session.csrf,
            homeserver,
            expires: session.expires,
          });
        }
        const { sid, session } = await adminSession(req);
        if (
          req.method !== "GET" &&
          !equal(req.headers["x-csrf-token"], session.csrf)
        )
          throw new HttpError(403, "CSRF 校验失败，请刷新页面");
        if (path === "/api/session" && req.method === "GET")
          return send(res, 200, {
            userId: session.userId,
            csrf: session.csrf,
            homeserver,
            expires: session.expires,
          });
        if (path === "/api/logout" && req.method === "POST") {
          sessions.delete(sid);
          if (session.owned)
            await matrix(
              homeserver,
              session.token,
              "POST",
              "/_matrix/client/v3/logout",
              {},
            ).catch(() => {});
          store.audit(session.userId, "退出登录");
          res.setHeader("Set-Cookie", cookie("", 0));
          return send(res, 200, { ok: true });
        }
        if (path === "/api/catalog" && req.method === "GET")
          return send(res, 200, catalog);
        if (path === "/api/audit" && req.method === "GET")
          return send(res, 200, { entries: store.state.audit });
        if (path === "/api/admin" && req.method === "POST") {
          const input = await json(req);
          const upstream = buildRequest(
            input.id,
            input.params,
            input.query,
            input.body,
          );
          const mutating = upstream.method !== "GET";
          if (mutating && input.confirm !== true)
            throw new HttpError(400, "写操作需要明确确认");
          const target = Object.entries(input.params || {})
            .filter(([key]) => !/token|password|secret/i.test(key))
            .map(([, v]) => String(v))
            .join(" · ")
            .slice(0, 512);
          try {
            const data = await matrix(
              homeserver,
              session.token,
              upstream.method,
              upstream.path,
              upstream.body,
            );
            if (mutating)
              store.audit(session.userId, upstream.endpoint.label, target);
            return send(res, 200, data);
          } catch (error) {
            if (mutating)
              store.audit(
                session.userId,
                upstream.endpoint.label,
                target,
                "failed",
              );
            throw error;
          }
        }
        if (path === "/api/policy" && req.method === "GET")
          return send(res, 200, {
            ...store.publicPolicy(),
            running: runner.busy,
          });
        if (path === "/api/policy" && req.method === "PUT") {
          if (runner.busy) throw new HttpError(409, "清理运行期间不能修改策略");
          const input = await json(req);
          if (input.confirm !== true)
            throw new HttpError(400, "保存策略需要明确确认");
          const policy = validatePolicy(input);
          let credential =
            store.state.policy?.homeserver === homeserver
              ? store.state.policy?.credential
              : null;
          let owner = store.state.policy?.owner;
          if (input.schedulerToken) {
            owner = await verifyAdmin(homeserver, input.schedulerToken);
            credential = store.seal(input.schedulerToken);
          }
          if (policy.enabled && !credential)
            throw new HttpError(400, "启用策略需要独立的管理员访问令牌");
          store.state.policy = {
            ...policy,
            credential,
            owner,
            homeserver,
            nextRun: Date.now() + policy.intervalHours * 3600000,
          };
          store.audit(
            session.userId,
            "更新媒体生命周期策略",
            policy.enabled ? "enabled" : "disabled",
          );
          return send(res, 200, store.publicPolicy());
        }
        if (path === "/api/policy/run" && req.method === "POST") {
          if ((await json(req)).confirm !== true)
            throw new HttpError(400, "清理需要明确确认");
          return send(res, 200, await runner.run(true));
        }
        throw new HttpError(404, "接口不存在");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HttpError(405, "不支持的请求方法");
      const relative = decodeURIComponent(path).replace(/^\/+/, "");
      const target = resolve(staticDir, relative || "index.html");
      if (target !== staticDir && !target.startsWith(staticDir + sep))
        throw new HttpError(403, "禁止访问");
      let file,
        actual = target;
      try {
        file = await readFile(target);
      } catch {
        if (extname(path)) throw new HttpError(404, "文件不存在");
        actual = resolve(staticDir, "index.html");
        file = await readFile(actual);
      }
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        }[extname(actual)] || "application/octet-stream",
      );
      res.end(req.method === "HEAD" ? undefined : file);
    } catch (error) {
      if (res.headersSent) return res.end();
      send(res, error.status || 500, {
        error: error.status ? error.message : "服务内部错误，请检查部署配置",
        errcode: error.code || "M_UNKNOWN",
      });
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  const cleanup = setInterval(() => {
    for (const [id, s] of sessions)
      if (s.expires <= Date.now()) {
        sessions.delete(id);
        if (s.owned)
          matrix(
            homeserver,
            s.token,
            "POST",
            "/_matrix/client/v3/logout",
            {},
          ).catch(() => {});
      }
    for (const [addr, times] of attempts)
      if (times.every((t) => Date.now() - t > 600000)) attempts.delete(addr);
  }, 60000).unref();
  const schedule =
    config.scheduler === false
      ? null
      : setInterval(() => runner.run().catch(() => {}), 60000).unref();
  server.on("close", () => {
    clearInterval(cleanup);
    clearInterval(schedule);
  });
  return { server, store, runner };
}
