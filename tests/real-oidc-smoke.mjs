// Destructive smoke test, ONLY for the disposable localhost matrix.test fixture.
// Start the fixture with the exact Docker command in docs/TESTING.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRust } from "./helpers.mjs";
const upstream = "http://127.0.0.1:18009";
const password = "Disposable-Fixture-Only-2026!";
let token;
async function client(path, method = "GET", body) {
  const r = await fetch(upstream + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, data: await r.json() };
}
let registration = await client("/_matrix/client/v3/register", "POST", {
  username: "admin",
  password,
});
if (registration.status === 401) {
  const session = registration.data.session;
  registration = await client("/_matrix/client/v3/register", "POST", {
    username: "admin",
    password,
    auth: {
      type: "m.login.registration_token",
      token: "local-integration-only",
      session,
    },
  });
  if (registration.status === 401)
    registration = await client("/_matrix/client/v3/register", "POST", {
      username: "admin",
      password,
      auth: { type: "m.login.dummy", session },
    });
}
if (
  registration.status === 400 &&
  registration.data.errcode === "M_USER_IN_USE"
)
  registration = await client("/_matrix/client/v3/login", "POST", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: "admin" },
    password,
  });
assert.equal(registration.status, 200, JSON.stringify(registration.data));
assert.equal(
  registration.data.user_id,
  "@admin:matrix.test",
  "Refusing a non-fixture homeserver",
);
token = registration.data.access_token;

const app = await startRust({
  homeserver: upstream,
  publicUrl: "https://admin.example.com",
  secureCookie: true,
});
const publicOrigin = "https://admin.example.com";
const post = async (path, body, headers = {}) =>
  fetch(app.base + "/api" + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: publicOrigin,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const jar = new Map();
const saveCookies = (r) => {
  for (const value of r.headers.getSetCookie()) {
    const pair = value.split(";")[0],
      i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const cookies = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
const hidden = (html) =>
  Object.fromEntries(
    [
      ...html.matchAll(
        /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g,
      ),
    ].map((m) => [m[1], m[2].replaceAll("&amp;", "&")]),
  );
try {
  const probe = await post("/auth/discover", {});
  const discovery = await probe.json();
  assert.equal(discovery.oauth, true, discovery.warning);
  console.log("PASS real Tuwunel OAuth metadata discovery");
  const start = await post("/auth/start", { kind: "oauth" });
  const began = await start.json();
  assert.equal(start.status, 200, JSON.stringify(began));
  const authCookie = start.headers.get("set-cookie").split(";")[0];
  let url = new URL(began.url),
    response,
    callback;
  for (let steps = 0; steps < 12; steps++) {
    if (url.origin === publicOrigin) {
      callback = url;
      break;
    }
    assert.equal(
      url.origin,
      upstream,
      "Fixture must never contact other servers",
    );
    response = await fetch(url, {
      redirect: "manual",
      headers: { cookie: cookies() },
    });
    saveCookies(response);
    if (response.status >= 300 && response.status < 400) {
      url = new URL(response.headers.get("location"), upstream);
      continue;
    }
    assert.equal(response.status, 200, "OAuth fixture page");
    const html = await response.text();
    const fields = hidden(html);
    let endpoint;
    if (url.pathname.endsWith("/native")) {
      fields.mode = "login";
      fields.username = "admin";
      fields.password = password;
      endpoint = "/_tuwunel/oidc/native";
    } else if (html.includes('value="approve"')) {
      fields.action = "approve";
      endpoint = "/_tuwunel/oidc/_complete";
    } else
      throw new Error("Unexpected native OAuth fixture step " + url.pathname);
    response = await fetch(upstream + endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: cookies(),
        origin: upstream,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
    saveCookies(response);
    if (response.status === 200) {
      const html = await response.text();
      const handoff = /<a[^>]+href="([^"]+)"[^>]*>Continue<\/a>/.exec(html);
      assert.ok(handoff, "Expected Tuwunel HTML handoff after consent");
      url = new URL(handoff[1].replaceAll("&amp;", "&"), upstream);
      continue;
    }
    assert.ok(
      response.status >= 300 && response.status < 400,
      "Native OAuth submit failed: " + response.status,
    );
    url = new URL(response.headers.get("location"), upstream);
  }
  assert.ok(
    callback,
    "Authorization did not return to the registered redirect URI",
  );
  assert.ok(callback.searchParams.get("code"));
  const completed = await fetch(
    app.base + callback.pathname + callback.search,
    { headers: { cookie: authCookie }, redirect: "manual" },
  );
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get("location"), "/");
  const sessionCookie = completed.headers
    .getSetCookie()
    .find((v) => v.startsWith("ta_session="))
    .split(";")[0];
  const session = await (
    await fetch(app.base + "/api/session", {
      headers: { cookie: sessionCookie },
    })
  ).json();
  assert.equal(session.userId, "@admin:matrix.test");
  console.log(
    "PASS dynamic client registration / native authentication / consent / PKCE exchange / administrator verification",
  );
  const users = await post(
    "/admin",
    { id: "users", params: {}, query: { limit: 10 } },
    { cookie: sessionCookie, "x-csrf-token": session.csrf },
  );
  assert.equal(users.status, 200);
  console.log("PASS real Matrix admin API using OAuth-issued token");
  const device = new URL(began.url).searchParams
    .get("scope")
    .split(" ")
    .find((s) => s.includes(":device:"))
    .split(":")
    .at(-1);
  assert.ok(
    (await client("/_matrix/client/v3/devices")).data.devices.some(
      (d) => d.device_id === device,
    ),
  );
  const logout = await post(
    "/logout",
    {},
    { cookie: sessionCookie, "x-csrf-token": session.csrf },
  );
  assert.equal(logout.status, 200);
  let revoked = false;
  for (let i = 0; i < 40; i++) {
    if (
      !(await client("/_matrix/client/v3/devices")).data.devices.some(
        (d) => d.device_id === device,
      )
    ) {
      revoked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(revoked, "OAuth logout must remove its upstream device");
  console.log("PASS OAuth logout and verified upstream session revocation");
} finally {
  await app.stop();
  await client("/_matrix/client/v3/logout", "POST", {});
}
