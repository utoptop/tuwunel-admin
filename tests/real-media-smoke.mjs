// ONLY the disposable matrix.test instance documented in docs/TESTING.md.
import assert from "node:assert/strict";
import { startRust } from "./helpers.mjs";
const upstream = "http://127.0.0.1:18008",
  password = "Disposable-Fixture-Only-2026!";
const login = await fetch(upstream + "/_matrix/client/v3/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: "admin" },
    password,
  }),
}).then((r) => r.json());
assert.equal(
  login.user_id,
  "@admin:matrix.test",
  "Refusing non-fixture server",
);
const app = await startRust({ homeserver: upstream });
let cookie = "",
  csrf = "";
async function api(path, body) {
  const r = await fetch(app.base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: "http://admin.test",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  if (path === "/login") {
    cookie = r.headers.get("set-cookie").split(";")[0];
    csrf = d.csrf;
  }
  return d;
}
const admin = (id, params = {}, query = {}, body) =>
  api("/admin", { id, params, query, body, confirm: true });
try {
  await api("/login", { username: "admin", password });
  const users = ["@media_batch_a:matrix.test", "@media_batch_b:matrix.test"];
  const totals = [215, 137];
  for (let n = 0; n < users.length; n++) {
    await admin(
      "saveUser",
      { user_id: users[n] },
      {},
      { password, displayname: "批量清理测试 " + n },
    );
    const r = await fetch(upstream + "/_matrix/client/v3/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: users[n] },
        password,
      }),
    });
    const auth = await r.json();
    assert.equal(r.status, 200, JSON.stringify(auth));
    for (let offset = 0; offset < totals[n]; offset += 8) {
      await Promise.all(
        Array.from(
          { length: Math.min(8, totals[n] - offset) },
          async (_, i) => {
            const r = await fetch(
              upstream +
                "/_matrix/media/v3/upload?filename=batch-" +
                (offset + i) +
                ".txt",
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + auth.access_token,
                  "Content-Type": "text/plain",
                },
                body:
                  "Disposable media cleanup fixture " + n + " " + (offset + i),
              },
            );
            assert.equal(r.status, 200);
            await r.json();
          },
        ),
      );
    }
    assert.equal(
      (await admin("userMedia", { user_id: users[n] }, { limit: 1 })).total,
      totals[n],
    );
  }
  const start = await api("/media/jobs", {
    users,
    confirmation: "删除 2 位用户的全部媒体",
  });
  let job;
  for (let i = 0; i < 300; i++) {
    job = (await api("/media/jobs")).jobs.find((j) => j.id === start.id);
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(job.status, "complete", JSON.stringify(job));
  assert.deepEqual(
    job.users.map((u) => u.deleted),
    totals,
  );
  for (const user_id of users) {
    assert.equal(
      (await admin("userMedia", { user_id }, { limit: 1 })).total,
      0,
    );
    assert.equal((await admin("user", { user_id })).deactivated, false);
  }
  console.log(
    "PASS real Tuwunel deleted all 352 files across two users; accounts remain active",
  );
  const rooms = await api("/rooms", { from: 0, search: "" });
  assert.ok(
    rooms.rooms.some(
      (r) => r.name === "桥接联调 · 工作空间" && r.avatar?.startsWith("mxc://"),
    ),
  );
  console.log("PASS real room directory returns room names and avatars");
  await api("/logout", {});
} finally {
  await app.stop();
  await fetch(upstream + "/_matrix/client/v3/logout", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + login.access_token,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}
