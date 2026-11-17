import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRust } from "./helpers.mjs";

async function fake(t) {
  const calls = [];
  let isAdmin = true,
    failRemote = false,
    redirect = false;
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const url = new URL(req.url, "http://localhost");
    calls.push({
      method: req.method,
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      body: text ? JSON.parse(text) : null,
      auth: req.headers.authorization,
    });
    const send = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/credentials" });
      return res.end();
    }
    if (req.headers.authorization === "Bearer bad")
      return send({ error: "Invalid token", errcode: "M_UNKNOWN_TOKEN" }, 401);
    if (url.pathname === "/_matrix/client/v3/login")
      return send({ access_token: "password-token", user_id: "@admin:test" });
    if (url.pathname.endsWith("/whoami"))
      return send({ user_id: "@admin:test" });
    if (
      decodeURIComponent(url.pathname) ===
      "/_synapse/admin/v2/users/@admin:test"
    )
      return send({ name: "@admin:test", admin: isAdmin });
    if (url.pathname.endsWith("/media/delete")) return send({ total: 3 });
    if (url.pathname.endsWith("/purge_media_cache"))
      return failRemote
        ? send({ error: "Remote failed" }, 503)
        : send({ deleted: 2 });
    if (url.pathname.endsWith("/accountdata"))
      return send({ errcode: "M_UNRECOGNIZED" }, 404);
    return send({
      ok: true,
      users: [{ name: "@admin:test", admin: true }],
      total: 1,
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    calls,
    setAdmin: (v) => (isAdmin = v),
    setRemoteFailure: (v) => (failRemote = v),
    setRedirect: (v) => (redirect = v),
  };
}
function client(app) {
  let cookie = "",
    csrf = "";
  return async function call(path, method = "GET", body, overrides = {}) {
    const res = await fetch(app.base + "/api" + path, {
      method,
      headers: {
        Origin: "http://admin.test",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...overrides,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (path === "/login" && res.ok) {
      cookie = res.headers.get("set-cookie").split(";")[0];
      csrf = data.csrf;
    }
    return { status: res.status, data, headers: res.headers };
  };
}
async function fixture(t, options = {}) {
  const upstream = await fake(t);
  const app = await startRust({ homeserver: upstream.origin, ...options });
  t.after(() => app.stop());
  return { upstream, app, call: client(app) };
}
const policy = {
  enabled: true,
  localDays: 90,
  remoteDays: 30,
  intervalHours: 24,
  sizeGt: 1024,
  keepProfiles: true,
  confirm: true,
};

test("Rust health, public config, 73-operation catalog and private session", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/health")).data.runtime, "rust");
  const config = (await f.call("/config")).data;
  assert.equal(config.locked, true);
  assert.equal(config.homeserver, f.upstream.origin);
  assert.equal((await f.call("/catalog")).status, 401);
  const login = await f.call("/login", "POST", {
    username: "admin",
    password: "typed-password",
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.ok(!JSON.stringify(login.data).includes("password-token"));
  assert.equal((await f.call("/catalog")).data.length, 73);
  assert.equal((await f.call("/session")).data.homeserver, f.upstream.origin);
  const disk = await readFile(join(f.app.directory, "state.json"), "utf8");
  assert.ok(!disk.includes("typed-password"));
  assert.ok(!disk.includes("password-token"));
});
test("non-administrators and bad tokens cannot log in", async (t) => {
  const f = await fixture(t);
  f.upstream.setAdmin(false);
  assert.equal(
    (await f.call("/login", "POST", { username: "admin", password: "pw" }))
      .status,
    403,
  );
  assert.equal(f.upstream.calls.at(-1).path, "/_matrix/client/v3/logout");
  assert.equal(
    (await f.call("/login", "POST", { accessToken: "bad" })).status,
    401,
  );
});
test("locked server is enforced on the backend, not just the input field", async (t) => {
  const f = await fixture(t),
    other = await fake(t);
  assert.equal(
    (
      await f.call("/login", "POST", {
        homeserver: other.origin,
        accessToken: "test",
      })
    ).status,
    403,
  );
  assert.equal(other.calls.length, 0);
  assert.equal(f.upstream.calls.length, 0);
  assert.equal(
    (
      await f.call("/login", "POST", {
        homeserver: f.upstream.origin + "/",
        accessToken: "test",
      })
    ).status,
    200,
  );
});
test("custom mode with empty default accepts configured choices and rejects unlisted targets", async (t) => {
  const one = await fake(t),
    two = await fake(t),
    app = await startRust({ locked: false, allowed: [one.origin, two.origin] });
  t.after(() => app.stop());
  const a = client(app),
    b = client(app);
  assert.equal((await a("/config")).data.configured, true);
  assert.equal(
    (
      await a("/login", "POST", {
        homeserver: one.origin,
        accessToken: "first-token",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await b("/login", "POST", {
        homeserver: two.origin,
        accessToken: "second-token",
      })
    ).status,
    200,
  );
  assert.equal((await a("/session")).data.homeserver, one.origin);
  assert.equal((await b("/session")).data.homeserver, two.origin);
  assert.equal(
    (
      await a("/login", "POST", {
        homeserver: "https://unlisted.example",
        accessToken: "test",
      })
    ).status,
    403,
  );
});
test("custom public mode blocks private IP, HTTP, credentials and URL paths before sending tokens", async (t) => {
  const f = await fixture(t, { homeserver: "", locked: false });
  for (const homeserver of [
    "http://example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://[::ffff:127.0.0.1]",
    "https://user:pw@example.com",
    "https://example.com/path",
  ]) {
    const r = await f.call("/login", "POST", {
      homeserver,
      accessToken: "private-token",
    });
    assert.ok([400, 403].includes(r.status), homeserver);
  }
  assert.equal(f.upstream.calls.length, 0);
});
test("SSRF-safe DNS refuses localhost and redirects never forward credentials", async (t) => {
  const f = await fixture(t, { homeserver: "", locked: false });
  assert.equal(
    (
      await f.call("/login", "POST", {
        homeserver: "https://localhost",
        accessToken: "private-token",
      })
    ).status,
    502,
  );
  const g = await fixture(t);
  g.upstream.setRedirect(true);
  const r = await g.call("/login", "POST", { accessToken: "test" });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /重定向/);
});
test("CSRF, origin, allowlist, body limits and mutation confirmation", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test" });
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
        { "X-CSRF-Token": "x".repeat(48) },
      )
    ).status,
    403,
  );
  assert.equal((await f.call("/admin", "POST", { id: "unknown" })).status, 400);
  assert.equal(
    (
      await f.call("/admin", "POST", {
        id: "users",
        homeserver: "https://other.test",
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await f.call("/admin", "POST", {
        id: "users",
        query: { access_token: "test" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("/admin", "POST", {
        id: "user",
        params: { user_id: "../evil" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("/admin", "POST", {
        id: "users",
        body: { padding: "x".repeat(140000) },
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await f.call("/admin", "POST", {
        id: "password",
        params: { user_id: "@alice:test" },
        body: { new_password: "secret" },
      })
    ).status,
    400,
  );
  const r = await f.call("/admin", "POST", {
    id: "password",
    params: { user_id: "@alice:test" },
    body: { new_password: "secret", logout_devices: true },
    confirm: true,
  });
  assert.equal(r.status, 200);
  assert.equal(
    f.upstream.calls.at(-1).path,
    "/_synapse/admin/v1/reset_password/@alice:test",
  );
  const audit = (await f.call("/audit")).data;
  assert.equal(audit.entries[0].action, "重置密码");
  assert.ok(!JSON.stringify(audit).includes("secret"));
});
test("upstream unsupported errors remain visible", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test" });
  const r = await f.call("/admin", "POST", {
    id: "accountData",
    params: { user_id: "@alice:test" },
  });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /不支持此 API/);
});
test("server-isolated audits, policies and credentials, even with identical user IDs", async (t) => {
  const one = await fake(t),
    two = await fake(t),
    app = await startRust({ locked: false, allowed: [one.origin, two.origin] });
  t.after(() => app.stop());
  const a = client(app),
    b = client(app);
  await a("/login", "POST", { homeserver: one.origin, accessToken: "a" });
  await b("/login", "POST", { homeserver: two.origin, accessToken: "b" });
  assert.equal(
    (await a("/policy", "PUT", { ...policy, schedulerToken: "scheduler-a" }))
      .status,
    200,
  );
  assert.equal((await b("/policy")).data.hasCredential, false);
  assert.equal((await b("/policy", "PUT", policy)).status, 400);
  await b("/policy", "PUT", {
    ...policy,
    localDays: 7,
    schedulerToken: "scheduler-b",
  });
  assert.equal((await a("/policy")).data.localDays, 90);
  assert.equal((await b("/policy")).data.localDays, 7);
  const before = two.calls.length;
  assert.equal(
    (await a("/policy/run", "POST", { confirm: true })).data.lastResult.ok,
    true,
  );
  assert.equal(two.calls.length, before);
  assert.equal(one.calls.at(-1).auth, "Bearer scheduler-a");
  assert.ok(
    (await a("/audit")).data.entries.every((e) => e.homeserver === one.origin),
  );
  assert.ok(
    (await b("/audit")).data.entries.every((e) => e.homeserver === two.origin),
  );
  assert.ok(
    !(await readFile(join(app.directory, "state.json"), "utf8")).includes(
      "scheduler-a",
    ),
  );
});
test("persistent scheduler runs after restart without a browser session", async (t) => {
  const upstream = await fake(t),
    directory = await mkdtemp(join(tmpdir(), "tuwunel-persist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await startRust({ homeserver: upstream.origin, directory });
  let call = client(first);
  await call("/login", "POST", { accessToken: "test" });
  await call("/policy", "PUT", {
    ...policy,
    schedulerToken: "scheduler-persist",
  });
  await first.stop();
  const path = join(directory, "state.json"),
    saved = JSON.parse(await readFile(path, "utf8"));
  saved.policies[upstream.origin].nextRun = 0;
  await writeFile(path, JSON.stringify(saved));
  const second = await startRust({
    homeserver: upstream.origin,
    directory,
    scheduler: true,
  });
  t.after(() => second.stop());
  for (
    let i = 0;
    i < 30 &&
    !upstream.calls.some((c) => c.path.endsWith("/purge_media_cache"));
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(upstream.calls.at(-1).auth, "Bearer scheduler-persist");
  call = client(second);
  await call("/login", "POST", { accessToken: "test" });
  const p = (await call("/policy")).data;
  assert.equal(p.lastResult.ok, true);
  assert.equal(p.lastResult.counts.deleteOldMedia, 3);
  const local = upstream.calls.find((c) => c.path.endsWith("/media/delete"));
  assert.equal(local.query.keep_profiles, "true");
  assert.equal(local.query.size_gt, "1024");
  assert.ok(
    Math.abs(Number(local.query.before_ts) - (Date.now() - 90 * 86400000)) <
      5000,
  );
});
test("partial failure and revoked permissions never report successful cleanup", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { accessToken: "test" });
  await f.call("/policy", "PUT", { ...policy, schedulerToken: "scheduler" });
  f.upstream.setRemoteFailure(true);
  const partial = (await f.call("/policy/run", "POST", { confirm: true })).data
    .lastResult;
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.counts, { deleteOldMedia: 3 });
  const before = f.upstream.calls.filter((c) =>
    c.path.endsWith("/media/delete"),
  ).length;
  f.upstream.setAdmin(false);
  const denied = (await f.call("/policy/run", "POST", { confirm: true })).data
    .lastResult;
  assert.equal(denied.ok, false);
  assert.equal(
    f.upstream.calls.filter((c) => c.path.endsWith("/media/delete")).length,
    before,
  );
});
test("logout revokes password-created tokens but preserves imported credentials", async (t) => {
  const f = await fixture(t);
  await f.call("/login", "POST", { username: "admin", password: "pw" });
  await f.call("/logout", "POST", {});
  for (
    let i = 0;
    i < 10 && !f.upstream.calls.some((c) => c.path.endsWith("/logout"));
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.upstream.calls.at(-1).path, "/_matrix/client/v3/logout");
  assert.equal((await f.call("/session")).status, 401);
  await f.call("/login", "POST", { accessToken: "external" });
  const before = f.upstream.calls.length;
  await f.call("/logout", "POST", {});
  assert.equal(f.upstream.calls.length, before);
});
test("rate limit includes attempts with invalid custom URLs", async (t) => {
  const f = await fixture(t, {
    locked: false,
    homeserver: "",
    loginAttempts: 3,
  });
  for (let n = 0; n < 3; n++)
    assert.equal(
      (
        await f.call("/login", "POST", {
          homeserver: "invalid",
          accessToken: "test",
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.call("/login", "POST", {
        homeserver: "invalid",
        accessToken: "test",
      })
    ).status,
    429,
  );
});
