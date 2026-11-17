// Destructive smoke test, ONLY for the disposable localhost matrix.test fixture.
// Start the fixture with the exact Docker command in docs/TESTING.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRust } from "./helpers.mjs";
const upstream = "http://127.0.0.1:18008";
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
const directory = await mkdtemp(join(tmpdir(), "tuwunel-real-"));
const app = await startRust({
  homeserver: upstream,
  publicUrl: "http://test.local",
  directory,
});
const base = app.base;
let cookie = "",
  csrf = "";
const log = (message) => console.log("PASS", message);
async function api(path, method = "GET", body) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://test.local",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(data)}`);
  if (path === "/login") {
    cookie = r.headers.get("set-cookie").split(";")[0];
    csrf = data.csrf;
  }
  return data;
}
const call = (id, params = {}, query = {}, body) =>
  api("/admin", "POST", { id, params, query, body, confirm: true });
try {
  await api("/login", "POST", { username: "admin", password });
  log("administrator password login");
  const version = await call("version");
  console.log("Server: Tuwunel", version.server_version);
  const suffix = Date.now().toString(36),
    uid = `@smoke_${suffix}:matrix.test`;
  await call(
    "saveUser",
    { user_id: uid },
    {},
    { password, displayname: "集成测试用户", admin: false },
  );
  assert.equal((await call("user", { user_id: uid })).name, uid);
  log("create user / details");
  assert.ok(
    (
      await call("users", {}, { name: `smoke_${suffix}`, limit: 20 })
    ).users.some((u) => u.name === uid),
  );
  log("search / paginate users");
  await call(
    "password",
    { user_id: uid },
    {},
    { new_password: password + "new", logout_devices: true },
  );
  const userLogin = await client("/_matrix/client/v3/login", "POST", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: uid },
    password: password + "new",
  });
  assert.equal(userLogin.status, 200);
  log("password reset");
  await call("saveUser", { user_id: uid }, {}, { locked: true });
  assert.equal((await call("user", { user_id: uid })).locked, true);
  await call("saveUser", { user_id: uid }, {}, { locked: false });
  await call("suspend", { user_id: uid }, {}, { suspend: true });
  assert.equal((await call("user", { user_id: uid })).suspended, true);
  await call("suspend", { user_id: uid }, {}, { suspend: false });
  await call("nativeLock", { user_id: uid }, {}, { locked: true });
  assert.equal((await call("nativeLocked", { user_id: uid })).locked, true);
  await call("nativeLock", { user_id: uid }, {}, { locked: false });
  await call("nativeSuspend", { user_id: uid }, {}, { suspended: true });
  assert.equal(
    (await call("nativeSuspended", { user_id: uid })).suspended,
    true,
  );
  await call("nativeSuspend", { user_id: uid }, {}, { suspended: false });
  log("lock / suspend / restore / native Matrix admin routes");
  await call(
    "createDevice",
    { user_id: uid },
    {},
    { device_id: "SMOKE_DEVICE" },
  );
  await call(
    "saveDevice",
    { user_id: uid, device_id: "SMOKE_DEVICE" },
    {},
    { display_name: "Smoke device" },
  );
  assert.ok(
    (await call("devices", { user_id: uid })).devices.some(
      (d) => d.device_id === "SMOKE_DEVICE",
    ),
  );
  await call(
    "deleteDevice",
    { user_id: uid, device_id: "SMOKE_DEVICE" },
    {},
    {},
  );
  log("create / rename / delete devices");
  const room = (
    await client("/_matrix/client/v3/createRoom", "POST", {
      name: "集成测试房间",
      preset: "private_chat",
    })
  ).data.room_id;
  assert.ok(room);
  await call("joinRoom", { room_id_or_alias: room }, {}, { user_id: uid });
  assert.ok(
    (await call("userRooms", { user_id: uid })).joined_rooms.includes(room),
  );
  assert.ok(
    (await call("roomMembers", { room_id: room })).members.includes(uid),
  );
  await call("roomState", { room_id: room });
  await call("roomMessages", { room_id: room }, { dir: "b", limit: 10 });
  log("room join / members / user rooms / state / events");
  const upload = await fetch(
    upstream + "/_matrix/media/v3/upload?filename=smoke.txt",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: "test attachment",
    },
  );
  const media = await upload.json();
  assert.ok(upload.ok, JSON.stringify(media));
  const media_id = media.content_uri.split("/").at(-1);
  await call("media", { server_name: "matrix.test", media_id });
  assert.ok(
    (
      await call(
        "userMedia",
        { user_id: "@admin:matrix.test" },
        { from: 0, limit: 100 },
      )
    ).media.some((m) => m.media_id === media_id),
  );
  await call("mediaStats", {}, { from: 0, limit: 20 });
  await call("deleteMedia", { server_name: "matrix.test", media_id }, {}, {});
  log("upload / media metadata / user media / statistics / delete");
  const reg = await call(
    "createToken",
    {},
    {},
    { length: 24, uses_allowed: 5, expiry_time: null },
  );
  assert.ok(reg.token);
  await call("saveToken", { token: reg.token }, {}, { uses_allowed: 2 });
  assert.ok(
    (await call("tokens")).registration_tokens.some(
      (t) => t.token === reg.token,
    ),
  );
  await call("deleteToken", { token: reg.token }, {}, {});
  log("create / update / delete registration tokens");
  await api("/policy", "PUT", {
    enabled: true,
    localDays: 90,
    remoteDays: 30,
    intervalHours: 24,
    sizeGt: 0,
    keepProfiles: true,
    schedulerToken: token,
    confirm: true,
  });
  assert.equal(
    (await api("/policy/run", "POST", { confirm: true })).lastResult.ok,
    true,
  );
  log("persistent media retention / local & remote purge");
  await call("destinations", {}, { from: 0, limit: 20 });
  await call(
    "notice",
    {},
    {},
    { user_id: uid, content: { msgtype: "m.text", body: "集成测试通知" } },
  );
  log("federation list / server notice");
  await call("blockRoom", { room_id: room }, {}, { block: true });
  assert.equal((await call("roomBlock", { room_id: room })).block, true);
  const task = await call(
    "deleteRoomAsync",
    { room_id: room },
    {},
    { block: true, purge: true },
  );
  assert.ok(task.delete_id);
  let status;
  for (let n = 0; n < 20; n++) {
    status = await call("deleteStatus", { delete_id: task.delete_id });
    if (status.status === "complete") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(status.status, "complete");
  await call("tasks");
  log("room block / asynchronous deletion / task status");
  await call("deactivate", { user_id: uid }, {}, { erase: true });
  const removed = await call("user", { user_id: uid });
  assert.equal(removed.deactivated, true);
  assert.equal(removed.erased, true);
  log("deactivate and erase user");
  assert.ok((await api("/audit")).entries.length > 10);
  log("audit trail");
  await api("/logout", "POST", {});
  log("logout");
  console.log("All real Tuwunel smoke checks passed.");
} finally {
  await app.stop();
  await rm(directory, { recursive: true, force: true });
  await client("/_matrix/client/v3/logout", "POST", {});
}
