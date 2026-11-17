// Only use the disposable matrix.test fixture documented in docs/TESTING.md.
import assert from "node:assert/strict";
import { startRust } from "./helpers.mjs";
const upstream = "http://127.0.0.1:18008",
  password = "Disposable-Fixture-Only-2026!";
const signal = "@signal_188eba50-45a2-4c06-bf35-1810d88a44ee:matrix.test",
  telegram = "@telegram_1065132603:matrix.test";
async function matrix(path, method = "GET", body, token = "") {
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
let registration = await matrix("/_matrix/client/v3/register", "POST", {
  username: "admin",
  password,
});
if (registration.status === 401) {
  const session = registration.data.session;
  registration = await matrix("/_matrix/client/v3/register", "POST", {
    username: "admin",
    password,
    auth: {
      type: "m.login.registration_token",
      token: "local-integration-only",
      session,
    },
  });
  if (registration.status === 401)
    registration = await matrix("/_matrix/client/v3/register", "POST", {
      username: "admin",
      password,
      auth: { type: "m.login.dummy", session },
    });
}
if (registration.data.errcode === "M_USER_IN_USE")
  registration = await matrix("/_matrix/client/v3/login", "POST", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: "admin" },
    password,
  });
assert.equal(registration.status, 200, JSON.stringify(registration.data));
assert.equal(registration.data.user_id, "@admin:matrix.test");
const token = registration.data.access_token,
  app = await startRust({ homeserver: upstream });
let cookie = "",
  csrf = "";
async function api(path, method = "GET", body, expected = 200) {
  const r = await fetch(app.base + "/api" + path, {
    method,
    headers: {
      Origin: "http://admin.test",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  assert.equal(r.status, expected, JSON.stringify(data));
  if (path === "/login" && r.ok) {
    cookie = r.headers.get("set-cookie").split(";")[0];
    csrf = data.csrf;
  }
  return data;
}
const call = (id, params = {}, body = {}) =>
  api("/admin", "POST", { id, params, body, confirm: true });
async function upload(token) {
  const r = await fetch(
    upstream + "/_matrix/media/v3/upload?filename=workspace.png",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "image/png",
      },
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    },
  );
  assert.equal(r.status, 200);
  return (await r.json()).content_uri;
}
const log = (s) => console.log("PASS", s);
try {
  await api("/login", "POST", { username: "admin", password });
  const avatar = await upload(token);
  await call(
    "saveUser",
    { user_id: "@admin:matrix.test" },
    { avatar_url: avatar, displayname: "管理员 · 林辰" },
  );
  const context = await api("/context");
  assert.equal(context.profile.avatar_url, avatar);
  assert.ok(context.version.server_version);
  log("real administrator avatar and Tuwunel version context");
  const room = (
    await matrix(
      "/_matrix/client/v3/createRoom",
      "POST",
      {
        name: "桥接联调 · 工作空间",
        preset: "public_chat",
        initial_state: [
          { type: "m.room.avatar", state_key: "", content: { url: avatar } },
        ],
      },
      token,
    )
  ).data.room_id;
  assert.ok(room);
  for (const [id, name] of [
    [signal, "Signal 桥接成员"],
    [telegram, "Telegram 桥接成员"],
  ]) {
    await call(
      "saveUser",
      { user_id: id },
      { password, displayname: name, deactivated: false },
    );
    const login = await matrix("/_matrix/client/v3/login", "POST", {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: id },
      password,
    });
    assert.equal(login.status, 200);
    const userToken = login.data.access_token;
    const image = await upload(userToken);
    await upload(userToken);
    await call("saveUser", { user_id: id }, { avatar_url: image });
    assert.equal(
      (
        await matrix(
          "/_matrix/client/v3/join/" + encodeURIComponent(room),
          "POST",
          {},
          userToken,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await matrix(
          "/_matrix/client/v3/user/" +
            encodeURIComponent(id) +
            "/account_data/m.direct",
          "PUT",
          { "@admin:matrix.test": [room] },
          userToken,
        )
      ).status,
      200,
    );
  }
  const rooms = await api("/user-rooms", "POST", { user_id: signal });
  assert.equal(
    rooms.rooms.find((r) => r.room_id === room).name,
    "桥接联调 · 工作空间",
  );
  assert.equal(rooms.rooms.find((r) => r.room_id === room).avatar, avatar);
  log("real joined-room names and MXC avatars");
  const groups = await api("/directory", "POST", {
    group: "bridges",
    refresh: true,
  });
  assert.equal(groups.groups.Signal, 1);
  assert.equal(groups.groups.Telegram, 1);
  const preview = await api("/bridges/preview", "POST", {
    all: true,
    filter: { group: "bridges" },
  });
  assert.equal(preview.count, 2);
  const job = await api("/bridges/cleanup", "POST", {
    plan: preview.plan,
    confirm: preview.confirmation,
  });
  let outcome;
  for (let i = 0; i < 180; i++) {
    outcome = (await api("/bridges/jobs")).jobs.find((j) => j.id === job.id);
    if (outcome.status !== "running") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(outcome.status, "complete", JSON.stringify(outcome));
  assert.equal(
    outcome.results.reduce((n, r) => n + r.mediaDeleted, 0),
    4,
  );
  assert.ok(outcome.results.every((r) => r.accountVerified && r.mediaVerified));
  log(
    "real Signal / Telegram cleanup, four owned media files, profile/device/account-data/room verification",
  );
  for (const id of [signal, telegram]) {
    const failed = await matrix("/_matrix/client/v3/login", "POST", {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: id },
      password,
    });
    assert.notEqual(failed.status, 200);
  }
  log("cleaned users can no longer log in");
  const rejected = await api(
    "/admin",
    "POST",
    {
      id: "saveToken",
      params: { token: "local-integration-only" },
      body: { uses_allowed: 5 },
      confirm: true,
    },
    403,
  );
  assert.equal(rejected.errcode, "M_CONFIG_TOKEN_READ_ONLY");
  const tokens = await call("tokens");
  assert.equal(
    tokens.registration_tokens.find((t) => t.token === "local-integration-only")
      .read_only,
    true,
  );
  log("real config-file token rejection classified as read-only");
  const managed = await call(
    "createToken",
    {},
    { length: 24, uses_allowed: 5 },
  );
  await call("saveToken", { token: managed.token }, { uses_allowed: 9 });
  await call("deleteToken", { token: managed.token });
  log("database registration-token create / update / delete");
  await api("/logout", "POST", {});
} finally {
  await app.stop();
  await matrix("/_matrix/client/v3/logout", "POST", {}, token);
}
