import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { buildRequest, catalog } from "../server/catalog.mjs";
import { normalizeHomeserver } from "../server/matrix.mjs";
import { Store } from "../server/store.mjs";
import { validatePolicy } from "../server/policy.mjs";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
async function fixture(t) {
  const calls = [];
  let admin = true,
    remoteFailure = false;
  const upstream = http.createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const url = new URL(req.url, "http://localhost");
    calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: text ? JSON.parse(text) : null,
      auth: req.headers.authorization,
    });
    const reply = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.endsWith("/login") && url.pathname.startsWith("/_matrix"))
      return reply({
        user_id: "@admin:test",
        access_token: "password-login-secret",
      });
    if (req.headers.authorization === "Bearer bad")
      return reply({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }, 401);
    if (url.pathname.endsWith("/whoami"))
      return reply({ user_id: "@admin:test" });
    if (url.pathname === "/_synapse/admin/v2/users/%40admin%3Atest")
      return reply({ name: "@admin:test", admin });
    if (url.pathname.endsWith("/purge_media_cache"))
      return remoteFailure
        ? reply({ error: "Remote purge unavailable" }, 503)
        : reply({ deleted: 2 });
    if (url.pathname.endsWith("/media/delete"))
      return reply({ total: 3, deleted_media: ["a", "b", "c"] });
    if (url.pathname.endsWith("/server_version"))
      return reply({ server_name: "Tuwunel", server_version: "test" });
    if (url.pathname.endsWith("/accountdata"))
      return reply({ errcode: "M_UNRECOGNIZED", error: "Unrecognized" }, 404);
    return reply({ ok: true, users: [], total: 0 });
  });
  const homeserver = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), "tuwunel-admin-test-"));
  const app = createApp({
    homeserver,
    publicUrl: "http://admin.test",
    dataDir: directory,
    scheduler: false,
  });
  const base = await listen(app.server);
  t.after(async () => {
    await close(app.server);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  });
  let cookie = "",
    csrf = "";
  async function call(path, method = "GET", body, headers = {}) {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: "http://admin.test",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (path === "/login" && response.ok) {
      cookie = response.headers.get("set-cookie").split(";")[0];
      csrf = data.csrf;
    }
    return { status: response.status, data, headers: response.headers };
  }
  return {
    app,
    call,
    calls,
    directory,
    homeserver,
    setAdmin: (v) => (admin = v),
    setRemoteFailure: (v) => (remoteFailure = v),
  };
}

test("catalog uses unique allowlisted operations and safe encoded paths", () => {
  assert.equal(new Set(catalog.map((e) => e.id)).size, catalog.length);
  assert.equal(catalog.length, 73);
  assert.equal(
    buildRequest("joinRoom", { room_id_or_alias: "#lounge:example.org" }).path,
    "/_synapse/admin/v1/join/%23lounge%3Aexample.org",
  );
  for (const value of ["../evil", "%2e%2e", "x\\y", "x\n"])
    assert.throws(() => buildRequest("user", { user_id: value }));
  assert.throws(() => buildRequest("http://attacker.test"));
  assert.throws(() => buildRequest("users", {}, { access_token: "secret" }));
  assert.throws(() => normalizeHomeserver("https://user:pass@example.org"));
  assert.throws(() => normalizeHomeserver("https://example.org/path"));
});
test("authentication requires administrator and never exposes the upstream token", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/admin", "POST", { id: "users" })).status, 401);
  f.setAdmin(false);
  assert.equal(
    (await f.call("/login", "POST", { accessToken: "test-secret" })).status,
    403,
  );
  f.setAdmin(true);
  const login = await f.call("/login", "POST", {
    username: "admin",
    password: "typed-secret",
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.userId, "@admin:test");
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.ok(!JSON.stringify(login.data).includes("password-login-secret"));
  const session = await f.call("/session");
  assert.equal(session.status, 200);
  assert.ok(!JSON.stringify(session.data).includes("password-login-secret"));
  const stored = await readFile(join(f.directory, "state.json"), "utf8");
  assert.ok(!stored.includes("typed-secret"));
  assert.ok(!stored.includes("password-login-secret"));
});
test("proxy enforces origin, CSRF, operation allowlist and mutation confirmation", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test-secret" });
  assert.equal(
    (
      await f.call(
        "/admin",
        "POST",
        { id: "users" },
        { Origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/admin",
        "POST",
        { id: "users" },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal((await f.call("/admin", "POST", { id: "unknown" })).status, 400);
  assert.equal(
    (
      await f.call("/admin", "POST", {
        id: "password",
        params: { user_id: "@alice:test" },
        body: { new_password: "private" },
      })
    ).status,
    400,
  );
  const update = await f.call("/admin", "POST", {
    id: "password",
    params: { user_id: "@alice:test" },
    body: { new_password: "private", logout_devices: true },
    confirm: true,
  });
  assert.equal(update.status, 200);
  assert.deepEqual(f.calls.at(-1), {
    method: "POST",
    path: "/_synapse/admin/v1/reset_password/%40alice%3Atest",
    query: {},
    body: { new_password: "private", logout_devices: true },
    auth: "Bearer test-secret",
  });
  const audit = await f.call("/audit");
  assert.equal(audit.data.entries[0].action, "重置密码");
  assert.ok(!JSON.stringify(audit.data).includes("private"));
  assert.ok(!JSON.stringify(audit.data).includes("test-secret"));
});
test("unsupported API surfaces a clear error instead of reporting success", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test-secret" });
  const r = await f.call("/admin", "POST", {
    id: "accountData",
    params: { user_id: "@a:test" },
  });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /不支持此 API/);
});
test("retention keeps encrypted credentials across restart and sends time cutoffs as query parameters", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test-secret" });
  const policy = {
    enabled: true,
    localDays: 90,
    remoteDays: 30,
    intervalHours: 24,
    sizeGt: 1024,
    keepProfiles: true,
    confirm: true,
  };
  assert.equal((await f.call("/policy", "PUT", policy)).status, 400);
  const saved = await f.call("/policy", "PUT", {
    ...policy,
    schedulerToken: "scheduler-private-token",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.hasCredential, true);
  assert.ok(!JSON.stringify(saved.data).includes("scheduler-private-token"));
  const disk = await readFile(join(f.directory, "state.json"), "utf8");
  assert.ok(!disk.includes("scheduler-private-token"));
  const reloaded = new Store(f.directory);
  assert.equal(
    reloaded.unseal(reloaded.state.policy.credential),
    "scheduler-private-token",
  );
  assert.equal(await f.app.runner.run(), undefined, "not due yet");
  const started = Date.now();
  const r = await f.call("/policy/run", "POST", { confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.lastResult, {
    ok: true,
    counts: { deleteOldMedia: 3, purgeRemote: 2 },
  });
  const local = f.calls.find((c) => c.path.endsWith("/media/delete"));
  assert.equal(local.query.keep_profiles, "true");
  assert.equal(local.query.size_gt, "1024");
  assert.ok(
    Math.abs(Number(local.query.before_ts) - (started - 90 * 86400000)) < 1000,
  );
  assert.equal(local.auth, "Bearer scheduler-private-token");
  assert.deepEqual(local.body, {});
  await f.call("/logout", "POST", {});
  assert.equal((await f.call("/session")).status, 401);
  assert.equal(
    (await f.app.runner.run(true)).lastResult.ok,
    true,
    "independent token survives logout",
  );
});
test("retention records partial failure, rejects invalid settings and revoked admin credentials", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test-secret" });
  const p = {
    enabled: true,
    localDays: 90,
    remoteDays: 30,
    intervalHours: 24,
    sizeGt: 0,
    keepProfiles: true,
    confirm: true,
    schedulerToken: "scheduler-private-token",
  };
  assert.throws(() => validatePolicy({ ...p, localDays: 0 }));
  assert.throws(() => validatePolicy({ ...p, enabled: "true" }));
  await f.call("/policy", "PUT", p);
  f.setRemoteFailure(true);
  const partial = await f.app.runner.run(true);
  assert.equal(partial.lastResult.ok, false);
  assert.deepEqual(partial.lastResult.counts, { deleteOldMedia: 3 });
  const before = f.calls.filter((c) => c.path.endsWith("/media/delete")).length;
  f.setAdmin(false);
  const revoked = await f.app.runner.run(true);
  assert.equal(revoked.lastResult.ok, false);
  assert.equal(
    f.calls.filter((c) => c.path.endsWith("/media/delete")).length,
    before,
  );
});
test("logout revokes only password-created Matrix sessions", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", {
    username: "admin",
    password: "typed-secret",
  });
  await f.call("/logout", "POST", {});
  assert.equal(f.calls.at(-1).path, "/_matrix/client/v3/logout");
  await f.call("/login", "POST", { accessToken: "external-token" });
  const before = f.calls.length;
  await f.call("/logout", "POST", {});
  assert.equal(f.calls.length, before);
});
test("login rate limiter bounds unsuccessful attempts", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.call("/login", "POST", { accessToken: "bad" })).status,
      401,
    );
  assert.equal(
    (await f.call("/login", "POST", { accessToken: "bad" })).status,
    429,
  );
});
