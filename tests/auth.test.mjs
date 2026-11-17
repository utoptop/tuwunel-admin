import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRust } from "./helpers.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);
async function upstream(t, options = {}) {
  let origin,
    admin = true,
    refreshCount = 0,
    registrationCount = 0,
    imageMode = "png",
    metadataOverride = {},
    lastAuth;
  const calls = [],
    grants = new Map();
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const u = new URL(req.url, origin);
    const data = text
      ? req.headers["content-type"]?.includes("json")
        ? JSON.parse(text)
        : Object.fromEntries(new URLSearchParams(text))
      : {};
    calls.push({
      path: u.pathname,
      method: req.method,
      data,
      auth: req.headers.authorization,
    });
    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const meta = {
      issuer: origin + "/",
      authorization_endpoint: origin + "/authorize",
      token_endpoint: origin + "/token",
      revocation_endpoint: origin + "/revoke",
      registration_endpoint: origin + "/register",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["urn:matrix:client:api:*"],
      authorization_response_iss_parameter_supported: true,
      ...metadataOverride,
    };
    if (u.pathname.endsWith("/auth_metadata"))
      return options.oauth
        ? send(meta)
        : send({ errcode: "M_UNRECOGNIZED" }, 404);
    if (u.pathname.endsWith("/auth_issuer"))
      return send({ errcode: "M_UNRECOGNIZED" }, 404);
    if (u.pathname === "/_matrix/client/v3/login" && req.method === "GET")
      return send({
        flows: [
          ...(options.password ? [{ type: "m.login.password" }] : []),
          ...(options.sso
            ? [
                {
                  type: "m.login.sso",
                  identity_providers: [
                    { id: "example-idp", name: "Example Auth" },
                  ],
                },
                { type: "m.login.token" },
              ]
            : []),
        ],
      });
    if (u.pathname === "/_matrix/client/v3/login")
      return data.type === "m.login.token" &&
        data.token === "one-use-login-token"
        ? send({ access_token: "sso-access" })
        : data.type === "m.login.password"
          ? send({ access_token: "password-access" })
          : send({ error: "bad token" }, 401);
    if (u.pathname === "/register") {
      registrationCount++;
      assert.equal(data.token_endpoint_auth_method, "none");
      assert.equal(data.application_type, "web");
      assert.equal(data.client_uri, "http://admin.test");
      return send({
        client_id: "public-client",
        token_endpoint_auth_method: "none",
      });
    }
    if (u.pathname === "/authorize") {
      lastAuth = u;
      const code = "test-authorization-code";
      grants.set(code, {
        challenge: u.searchParams.get("code_challenge"),
        redirect: u.searchParams.get("redirect_uri"),
      });
      const callback = new URL(u.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", u.searchParams.get("state"));
      callback.searchParams.set("iss", origin + "/");
      res.writeHead(302, { location: callback.href });
      return res.end();
    }
    if (u.pathname === "/token") {
      if (data.grant_type === "refresh_token") {
        refreshCount++;
        if (options.refreshFailure)
          return send({ error: "invalid_grant" }, 400);
        return send({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      const g = grants.get(data.code);
      if (
        !g ||
        g.redirect !== data.redirect_uri ||
        g.challenge !==
          createHash("sha256").update(data.code_verifier).digest("base64url")
      )
        return send({ error: "invalid_grant" }, 400);
      grants.delete(data.code);
      return send({
        access_token: "oauth-access",
        refresh_token: "initial-refresh",
        token_type: "Bearer",
        expires_in: options.short ? 1 : 3600,
      });
    }
    if (u.pathname === "/revoke") return send({});
    if (u.pathname.endsWith("/whoami")) return send({ user_id: "@admin:test" });
    if (u.pathname.includes("/_synapse/admin/v2/users/"))
      return send({ admin });
    if (/\/media\/(?:v3\/)?(?:thumbnail|download)\//.test(u.pathname)) {
      if (options.legacy && u.pathname.startsWith("/_matrix/client"))
        return send({ errcode: "M_UNRECOGNIZED" }, 404);
      if (imageMode === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/leak" });
        return res.end();
      }
      if (imageMode === "large") {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": 3000000,
        });
        return res.end("too-large");
      }
      res.writeHead(200, {
        "content-type": imageMode === "svg" ? "image/svg+xml" : "image/png",
      });
      return res.end(imageMode === "svg" ? "<svg/>" : png);
    }
    return send({});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  return {
    origin,
    calls,
    get registrations() {
      return registrationCount;
    },
    get refreshes() {
      return refreshCount;
    },
    get authorization() {
      return lastAuth;
    },
    setAdmin: (v) => (admin = v),
    setImage: (v) => (imageMode = v),
    setMetadata: (v) => (metadataOverride = v),
  };
}
async function fixture(t, options = {}, appOptions = {}) {
  const up = await upstream(t, options);
  const app = await startRust({ homeserver: up.origin, ...appOptions });
  t.after(() => app.stop());
  return { up, app };
}
async function post(app, path, body, headers = {}) {
  const res = await fetch(app.base + "/api" + path, {
    method: "POST",
    headers: {
      origin: "http://admin.test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  return { res, data: await res.json() };
}
async function begin(app, kind = "oauth") {
  const r = await post(app, "/auth/start", { kind });
  assert.equal(r.res.status, 200, JSON.stringify(r.data));
  return {
    url: new URL(r.data.url),
    cookie: r.res.headers.get("set-cookie").split(";")[0],
    header: r.res.headers.get("set-cookie"),
  };
}
async function callback(app, url, cookie) {
  return fetch(app.base + url.pathname + url.search, {
    headers: { cookie },
    redirect: "manual",
  });
}
async function oauthLogin(app) {
  const b = await begin(app);
  const auth = await fetch(b.url, { redirect: "manual" });
  const cb = new URL(auth.headers.get("location"));
  const response = await callback(app, cb, b.cookie);
  return { response, cb, ...b };
}
function sessionCookie(response) {
  return response.headers
    .getSetCookie()
    .find((v) => v.startsWith("ta_session="))
    .split(";")[0];
}

test("discovery selects password, SSO or OAuth from server capabilities and enforces deployment address", async (t) => {
  for (const options of [{ password: true }, { sso: true }, { oauth: true }]) {
    const { app } = await fixture(t, options);
    const r = await post(app, "/auth/discover", {});
    assert.equal(r.res.status, 200);
    assert.equal(r.data.password, !!options.password);
    assert.equal(r.data.sso, !!options.sso);
    assert.equal(r.data.oauth, !!options.oauth);
    assert.equal(
      (await post(app, "/auth/discover", { homeserver: "https://other.test" }))
        .res.status,
      403,
    );
  }
  const { app, up } = await fixture(t, { sso: true });
  assert.equal(
    (await post(app, "/login", { username: "admin", password: "secret" })).res
      .status,
    400,
  );
  assert.ok(
    !up.calls.some((c) => c.path.endsWith("/login") && c.method === "POST"),
  );
  assert.equal(
    (await post(app, "/auth/start", { kind: "sso", provider: "untrusted" })).res
      .status,
    400,
  );
});
test("SSO binds callback to originating browser and one-time state, verifies admin, hides tokens", async (t) => {
  const { app, up } = await fixture(t, { sso: true });
  const b = await begin(app, "sso");
  assert.equal(b.url.origin, up.origin);
  assert.equal(b.url.pathname, "/_matrix/client/v3/login/sso/redirect");
  assert.match(b.header, /HttpOnly; SameSite=Lax; Max-Age=600/);
  const cb = new URL(b.url.searchParams.get("redirectUrl"));
  cb.searchParams.set("loginToken", "one-use-login-token");
  const wrong = await callback(app, cb, "ta_auth=wrong-browser");
  assert.match(wrong.headers.get("location"), /auth_error=expired/);
  assert.ok(!up.calls.some((c) => c.data.type === "m.login.token"));
  const response = await callback(app, cb, b.cookie);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(await response.text(), "");
  const cookie = sessionCookie(response);
  const session = await (
    await fetch(app.base + "/api/session", { headers: { cookie } })
  ).json();
  assert.equal(session.userId, "@admin:test");
  assert.ok(!JSON.stringify(session).includes("sso-access"));
  assert.match(
    (await callback(app, cb, b.cookie)).headers.get("location"),
    /auth_error=expired/,
  );
});
test("SSO rejects non-admin identity and revokes the created upstream login", async (t) => {
  const { app, up } = await fixture(t, { sso: true });
  up.setAdmin(false);
  const b = await begin(app, "sso");
  const cb = new URL(b.url.searchParams.get("redirectUrl"));
  cb.searchParams.set("loginToken", "one-use-login-token");
  const response = await callback(app, cb, b.cookie);
  assert.match(response.headers.get("location"), /auth_error=not_admin/);
  assert.ok(
    up.calls.some(
      (c) => c.path.endsWith("/logout") && c.auth === "Bearer sso-access",
    ),
  );
});
test("OAuth performs registration, PKCE code exchange, refresh rotation and revocation; credentials never reach the browser or disk", async (t) => {
  const { app, up } = await fixture(t, { oauth: true, short: true });
  const r = await oauthLogin(app);
  assert.equal(r.response.status, 303);
  assert.equal(r.response.headers.get("location"), "/");
  assert.equal(
    up.authorization.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.match(
    up.authorization.searchParams.get("scope"),
    /urn:matrix:client:device:/,
  );
  const cookie = sessionCookie(r.response);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(app.base + "/api/session", { headers: { cookie } }),
    ),
  );
  assert.ok(responses.every((r) => r.ok));
  const session = await responses[0].json();
  assert.equal(up.refreshes, 1);
  assert.ok(
    up.calls.some(
      (c) => c.path.endsWith("/whoami") && c.auth === "Bearer refreshed-access",
    ),
  );
  const disk = await readFile(join(app.directory, "state.json"), "utf8");
  for (const secret of [
    "oauth-access",
    "initial-refresh",
    "rotated-refresh",
    "refreshed-access",
  ]) {
    assert.ok(!disk.includes(secret));
    assert.ok(!JSON.stringify(session).includes(secret));
  }
  await begin(app);
  assert.equal(up.registrations, 1);
  const logout = await post(
    app,
    "/logout",
    {},
    { cookie, "x-csrf-token": session.csrf },
  );
  assert.equal(logout.res.status, 200);
  for (
    let i = 0;
    i < 30 &&
    !up.calls.some(
      (c) => c.path === "/revoke" && c.data.token === "refreshed-access",
    );
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    up.calls.some(
      (c) => c.path === "/revoke" && c.data.token === "rotated-refresh",
    ),
  );
  assert.ok(
    up.calls.some(
      (c) => c.path === "/revoke" && c.data.token === "refreshed-access",
    ),
  );
});
test("OAuth issuer mismatch, cancelled flow and replay never exchange an authorization code", async (t) => {
  const { app, up } = await fixture(t, { oauth: true });
  const b = await begin(app);
  const auth = await fetch(b.url, { redirect: "manual" });
  const cb = new URL(auth.headers.get("location"));
  cb.searchParams.set("iss", "https://wrong-issuer.test/");
  assert.match(
    (await callback(app, cb, b.cookie)).headers.get("location"),
    /auth_error=expired/,
  );
  assert.ok(!up.calls.some((c) => c.path === "/token"));
  const c = await begin(app);
  const cancelled = new URL("http://admin.test/api/auth/callback");
  cancelled.searchParams.set("state", c.url.searchParams.get("state"));
  cancelled.searchParams.set("error", "access_denied");
  assert.match(
    (await callback(app, cancelled, c.cookie)).headers.get("location"),
    /auth_error=expired/,
  );
});
test("failed OAuth renewal ends local session instead of using expired credentials", async (t) => {
  const { app } = await fixture(t, {
    oauth: true,
    short: true,
    refreshFailure: true,
  });
  const r = await oauthLogin(app);
  const cookie = sessionCookie(r.response);
  assert.equal(
    (await fetch(app.base + "/api/session", { headers: { cookie } })).status,
    401,
  );
  assert.equal(
    (await fetch(app.base + "/api/session", { headers: { cookie } })).status,
    401,
  );
});
test("authentication discovery cannot use a separate private endpoint without explicit configuration", async (t) => {
  const { app, up } = await fixture(t, { oauth: true });
  up.setMetadata({ token_endpoint: "http://127.0.0.1:1/token" });
  const r = await post(app, "/auth/discover", {});
  assert.equal(r.data.oauth, false);
  assert.ok(r.data.warning);
  assert.equal(
    (await post(app, "/auth/start", { kind: "oauth" })).res.status,
    400,
  );
});
test("registered public client IDs survive restart; configured clients skip automatic registration", async (t) => {
  const up = await upstream(t, { oauth: true });
  const directory = await mkdtemp(join(tmpdir(), "tuwunel-oauth-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let app = await startRust({ homeserver: up.origin, directory });
  await begin(app);
  await app.stop();
  app = await startRust({ homeserver: up.origin, directory });
  try {
    await begin(app);
    assert.equal(up.registrations, 1);
  } finally {
    await app.stop();
  }
  app = await startRust({
    homeserver: up.origin,
    authClient: { issuer: up.origin + "/", id: "pre-registered" },
  });
  try {
    const r = await begin(app);
    assert.equal(r.url.searchParams.get("client_id"), "pre-registered");
    assert.equal(up.registrations, 1);
  } finally {
    await app.stop();
  }
});
test("avatar proxy requires a matching session, uses authenticated media, rejects redirects/HTML/oversized images", async (t) => {
  const { app, up } = await fixture(t, { password: true });
  const query = new URLSearchParams({
    mxc: "mxc://matrix.test/avatar",
    homeserver: up.origin,
  });
  assert.equal((await fetch(app.base + "/api/avatar?" + query)).status, 401);
  const login = await post(app, "/login", { accessToken: "avatar-token" });
  const cookie = login.res.headers.get("set-cookie").split(";")[0];
  let response = await fetch(app.base + "/api/avatar?" + query, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(up.calls.at(-1).auth, "Bearer avatar-token");
  assert.match(
    up.calls.at(-1).path,
    /^\/_matrix\/client\/v1\/media\/thumbnail/,
  );
  query.set("homeserver", "https://other.test");
  assert.equal(
    (await fetch(app.base + "/api/avatar?" + query, { headers: { cookie } }))
      .status,
    403,
  );
  query.set("homeserver", up.origin);
  for (const [mode, status] of [
    ["svg", 415],
    ["redirect", 502],
    ["large", 502],
  ]) {
    up.setImage(mode);
    response = await fetch(app.base + "/api/avatar?" + query, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("location"), null);
  }
  for (const mxc of [
    "https://evil.test/a",
    "mxc://matrix.test/../admin",
    "mxc://matrix.test/%2e%2e",
  ]) {
    query.set("mxc", mxc);
    assert.equal(
      (await fetch(app.base + "/api/avatar?" + query, { headers: { cookie } }))
        .status,
      400,
    );
  }
});
test("avatar proxy falls back to the legacy media thumbnail endpoint", async (t) => {
  const { app, up } = await fixture(t, { legacy: true });
  const login = await post(app, "/login", { accessToken: "avatar-token" });
  const cookie = login.res.headers.get("set-cookie").split(";")[0];
  const response = await fetch(
    app.base +
      "/api/avatar?" +
      new URLSearchParams({
        homeserver: up.origin,
        mxc: "mxc://matrix.test/avatar",
      }),
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  assert.ok(
    up.calls.some((c) => c.path.startsWith("/_matrix/media/v3/thumbnail/")),
  );
});

test("OAuth supports a separately configured private authorization server", async (t) => {
  const matrix = await upstream(t, { oauth: true });
  const issuer = await upstream(t, { oauth: true });
  matrix.setMetadata({
    issuer: issuer.origin + "/",
    authorization_endpoint: issuer.origin + "/authorize",
    token_endpoint: issuer.origin + "/token",
    revocation_endpoint: issuer.origin + "/revoke",
    registration_endpoint: issuer.origin + "/register",
  });
  const app = await startRust({
    homeserver: matrix.origin,
    authAllowed: [issuer.origin],
  });
  t.after(() => app.stop());
  const result = await oauthLogin(app);
  assert.equal(result.response.headers.get("location"), "/");
  const cookie = sessionCookie(result.response);
  const session = await (
    await fetch(app.base + "/api/session", { headers: { cookie } })
  ).json();
  assert.equal(session.homeserver, matrix.origin);
  assert.equal(issuer.registrations, 1);
  assert.equal(matrix.registrations, 0);
  assert.ok(
    matrix.calls.some(
      (c) => c.path.endsWith("/whoami") && c.auth === "Bearer oauth-access",
    ),
  );
  assert.ok(!issuer.calls.some((c) => c.path.endsWith("/whoami")));
});
