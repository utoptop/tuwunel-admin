import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRust } from "./helpers.mjs";
const signal = "@signal_188eba50-45a2-4c06-bf35-1810d88a44ee:test",
  telegram = "@telegram_1065132603:test";
async function fixture(t, extraConfig = () => "") {
  const calls = [],
    users = new Map([
      [
        "@admin:test",
        {
          name: "@admin:test",
          admin: true,
          displayname: "管理员",
          avatar_url: "mxc://test/admin",
        },
      ],
      [
        signal,
        {
          name: signal,
          admin: false,
          displayname: "Signal 用户",
          avatar_url: "mxc://test/signal",
        },
      ],
      [telegram, { name: telegram, admin: false }],
      ["@signal_invalid:test", { name: "@signal_invalid:test", admin: false }],
      ["@telegram_bot:test", { name: "@telegram_bot:test", admin: false }],
      ["@telegram_99:test", { name: "@telegram_99:test", admin: true }],
      ["@alice:test", { name: "@alice:test", admin: false }],
    ]),
    media = new Map([
      [signal, ["a", "b", "c"]],
      [telegram, ["d"]],
    ]);
  let failMedia = false,
    failVersion = false;
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const u = new URL(req.url, "http://local"),
      path = decodeURIComponent(u.pathname),
      body = text ? JSON.parse(text) : null;
    calls.push({
      path,
      method: req.method,
      body,
      query: Object.fromEntries(u.searchParams),
    });
    const send = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (path.endsWith("/whoami")) return send({ user_id: "@admin:test" });
    if (path === "/_matrix/client/v3/login")
      return send(
        req.method === "GET"
          ? { flows: [{ type: "m.login.password" }] }
          : { access_token: "fixture-only", user_id: "@admin:test" },
      );
    if (path.includes("auth_metadata") || path.includes("auth_issuer"))
      return send({ errcode: "M_UNRECOGNIZED" }, 404);
    if (path.endsWith("server_version"))
      return failVersion
        ? send({ error: "version unavailable" }, 503)
        : send({ server_name: "Tuwunel", server_version: "2.0.0" });
    if (path === "/_synapse/admin/v2/users") {
      const from = Number(u.searchParams.get("from") || 0),
        all = [...users.values()],
        rows = all.slice(from, from + 2);
      return send({
        users: rows,
        total: all.length,
        ...(from + 2 < all.length ? { next_token: String(from + 2) } : {}),
      });
    }
    const user = path.match(/^\/_synapse\/admin\/v2\/users\/([^/]+)$/)?.[1];
    if (user)
      return users.has(user)
        ? send(users.get(user))
        : send({ errcode: "M_NOT_FOUND" }, 404);
    const id = path.match(
      /^\/_synapse\/admin\/(?:v1|v2)\/users\/(.+)\/(media|devices|joined_rooms|accountdata)$/,
    );
    if (id) {
      const user = users.get(id[1]);
      if (!user) return send({}, 404);
      if (id[2] === "media") {
        const files = media.get(id[1]) || [];
        if (req.method === "DELETE") {
          if (failMedia) return send({ deleted_media: [], total: 0 });
          return send({ deleted_media: files.splice(0, 2), total: 2 });
        }
        return send({
          media: files
            .slice(0, Number(u.searchParams.get("limit") || 20))
            .map((media_id) => ({ media_id })),
          total: files.length,
        });
      }
      if (id[2] === "devices")
        return send({
          devices: user.deactivated ? [] : [{ device_id: "ONE" }],
        });
      if (id[2] === "joined_rooms")
        return send({
          joined_rooms: user.deactivated ? [] : ["!named:test", "!gone:test"],
        });
      if (id[2] === "accountdata")
        return send({
          account_data: {
            global: user.deactivated ? {} : { "m.direct": {} },
            rooms: {},
          },
        });
    }
    const deactivate = path.match(
      /^\/_synapse\/admin\/v1\/deactivate\/(.+)$/,
    )?.[1];
    if (deactivate) {
      const u = users.get(deactivate);
      Object.assign(u, {
        deactivated: true,
        erased: true,
        avatar_url: null,
        displayname: null,
      });
      return send({});
    }
    if (path === "/_synapse/admin/v1/rooms")
      return send({
        rooms: [
          { room_id: "!named:test", name: "测试房间" },
          { room_id: "!gone:test", name: null },
        ],
        total_rooms: 42,
        next_batch: 20,
      });
    if (path === "/_synapse/admin/v1/rooms/!named:test")
      return send({
        name: "测试房间",
        avatar: "mxc://test/room",
        joined_members: 3,
      });
    if (path === "/_synapse/admin/v1/rooms/!gone:test")
      return send({ error: "Room gone", errcode: "M_NOT_FOUND" }, 404);
    if (path === "/_synapse/admin/v1/registration_tokens")
      return send({
        registration_tokens: [
          {
            token: "from-config",
            uses_allowed: null,
            expiry_time: null,
            completed: 0,
          },
          {
            token: "unlimited-db",
            uses_allowed: null,
            expiry_time: null,
            completed: 0,
          },
        ],
      });
    if (path.endsWith("/registration_tokens/from-config"))
      return send(
        {
          error: "Tokens set in the config file can't be updated",
          errcode: "M_FORBIDDEN",
        },
        403,
      );
    if (path.endsWith("/registration_tokens/unlimited-db"))
      return send({ token: "unlimited-db" });
    if (path.endsWith("/logout")) return send({});
    return send({ error: "unknown " + path }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`,
    app = await startRust({
      homeserver: origin,
      extraConfig: extraConfig(origin),
    });
  t.after(() => app.stop());
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, method = "GET", body, extra = {}) => {
      const r = await fetch(app.base + "/api" + path, {
        method,
        headers: {
          Origin: "http://admin.test",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (path === "/login" && r.ok) {
        cookie = r.headers.get("set-cookie").split(";")[0];
        csrf = data.csrf;
      }
      return { status: r.status, data };
    };
  }
  const call = client();
  await call("/login", "POST", { username: "admin", password: "fixture" });
  return {
    app,
    call,
    client,
    calls,
    users,
    media,
    origin,
    setMediaFailure: (v) => (failMedia = v),
    setVersionFailure: (v) => (failVersion = v),
  };
}
async function finished(f, id) {
  for (let i = 0; i < 200; i++) {
    const job = (await f.call("/bridges/jobs")).data.jobs.find(
      (j) => j.id === id,
    );
    if (job?.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("job timed out");
}
async function plan(f, ids) {
  const r = await f.call("/bridges/preview", "POST", { ids });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function start(f, p) {
  const r = await f.call("/bridges/cleanup", "POST", {
    plan: p.plan,
    confirm: p.confirmation,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
test("authenticated context and paginated room enrichment preserve missing room IDs", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client()("/context")).status, 401);
  const c = (await f.call("/context")).data;
  assert.equal(c.profile.avatar_url, "mxc://test/admin");
  assert.equal(c.version.server_version, "2.0.0");
  f.setVersionFailure(true);
  const fail = (await f.call("/context")).data;
  assert.equal(fail.profile.name, "@admin:test");
  assert.match(fail.versionError, /version unavailable/);
  const rooms = (await f.call("/user-rooms", "POST", { user_id: signal })).data;
  assert.equal(rooms.rooms[0].name, "测试房间");
  assert.equal(rooms.rooms[0].avatar, "mxc://test/room");
  assert.equal(rooms.rooms[1].room_id, "!gone:test");
  assert.match(rooms.rooms[1].error, /Room gone/);
  assert.equal(
    (await f.call("/user-rooms", "POST", { user_id: "../../evil" })).status,
    400,
  );
});
test("bridge directory classifies strict UUID/numeric formats across upstream pages", async (t) => {
  const f = await fixture(t),
    regular = (await f.call("/directory", "POST", {})).data;
  assert.equal(regular.total, 4);
  assert.ok(regular.users.some((u) => u.name === "@signal_invalid:test"));
  assert.equal(regular.counts.bridges, 3);
  const bridges = (await f.call("/directory", "POST", { group: "bridges" }))
    .data;
  assert.deepEqual(bridges.groups, { Signal: 1, Telegram: 2 });
  assert.equal(
    bridges.users.find((u) => u.name === "@telegram_99:test").protected,
    true,
  );
  assert.equal(
    (await f.call("/directory", "POST", { group: "Telegram", search: "1065" }))
      .data.total,
    1,
  );
  const preview = await f.call("/bridges/preview", "POST", {
    all: true,
    filter: { group: "bridges" },
  });
  assert.equal(preview.data.count, 2);
  assert.ok(
    !f.calls.some(
      (c) => c.method === "DELETE" || c.path.includes("/deactivate/"),
    ),
  );
  for (const id of [
    "@admin:test",
    "@telegram_99:test",
    "@alice:test",
    "@missing:test",
  ])
    assert.ok(
      (await f.call("/bridges/preview", "POST", { ids: [id] })).status >= 400,
    );
});
test("cleanup binds exact preview to session, drains all media from offset zero and verifies erasure", async (t) => {
  const f = await fixture(t),
    p = await plan(f, [signal, telegram]);
  assert.equal(
    (await f.call("/bridges/cleanup", "POST", { plan: p.plan, confirm: "yes" }))
      .status,
    400,
  );
  const other = f.client();
  await other("/login", "POST", { username: "admin", password: "fixture" });
  assert.equal(
    (
      await other("/bridges/cleanup", "POST", {
        plan: p.plan,
        confirm: p.confirmation,
      })
    ).status,
    403,
  );
  const id = await start(f, p);
  assert.equal(
    (
      await f.call("/bridges/cleanup", "POST", {
        plan: p.plan,
        confirm: p.confirmation,
      })
    ).status,
    409,
  );
  const job = await finished(f, id);
  assert.equal(job.status, "complete", JSON.stringify(job));
  assert.equal(job.processed, 2);
  assert.equal(
    job.results.reduce((n, r) => n + r.mediaDeleted, 0),
    4,
  );
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 3);
  assert.ok(
    f.calls
      .filter((c) => c.method === "DELETE")
      .every((c) => c.query.from === "0"),
  );
  assert.ok(job.results.every((r) => r.accountVerified && r.mediaVerified));
  const text = await readFile(join(f.app.directory, "state.json"), "utf8");
  assert.ok(!text.includes("fixture-only"));
});
test("promotion after preview prevents cleanup; partial media failure is retained and retryable", async (t) => {
  const f = await fixture(t),
    p = await plan(f, [signal]);
  f.users.get(signal).admin = true;
  const protectedJob = await finished(f, await start(f, p));
  assert.equal(protectedJob.status, "partial");
  assert.ok(!f.calls.some((c) => c.path.includes("/deactivate/")));
  f.users.get(signal).admin = false;
  f.setMediaFailure(true);
  const second = await finished(f, await start(f, await plan(f, [signal])));
  assert.equal(second.status, "partial");
  assert.equal(second.results[0].deactivated, true);
  assert.equal(second.results[0].mediaVerified, undefined);
  f.setMediaFailure(false);
  const retry = await finished(f, await start(f, await plan(f, [signal])));
  assert.equal(retry.status, "complete");
  assert.equal(f.media.get(signal).length, 0);
});
test("config-file token errors become persistent read-only markers without misclassifying unlimited database tokens", async (t) => {
  const f = await fixture(t);
  const api = (id, params = {}, body = {}) =>
    f.call("/admin", "POST", { id, params, body, confirm: true });
  let list = (await api("tokens")).data.registration_tokens;
  assert.ok(list.every((t) => !t.read_only));
  const rejected = await api(
    "saveToken",
    { token: "from-config" },
    { uses_allowed: 3 },
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.data.errcode, "M_CONFIG_TOKEN_READ_ONLY");
  assert.match(rejected.data.error, /registration_token/);
  list = (await api("tokens")).data.registration_tokens;
  assert.equal(list[0].read_only, true);
  assert.equal(list[1].read_only, false);
  assert.equal(
    (await api("saveToken", { token: "unlimited-db" }, { uses_allowed: null }))
      .status,
    200,
  );
  const disk = JSON.parse(
    await readFile(join(f.app.directory, "state.json"), "utf8"),
  );
  assert.equal(Object.keys(disk.readonlyTokens).length, 1);
  assert.ok(!JSON.stringify(disk).includes("from-config"));
});

test("custom bridge prefixes are scoped to exact configured homeserver", async (t) => {
  const f = await fixture(
    t,
    (origin) => `[bridges]
detect_common = false
[[bridges.rules]]
homeserver = ${JSON.stringify(origin)}
name = "Custom Telegram bot"
user_prefix = "@telegram_bot"
[[bridges.rules]]
homeserver = "https://different.example.com"
name = "Different server only"
user_prefix = "@alice"
`,
  );
  const rows = (await f.call("/directory", "POST", { group: "bridges" })).data;
  assert.equal(rows.total, 1);
  assert.equal(rows.users[0].name, "@telegram_bot:test");
  assert.equal(rows.users[0].bridge.source, "部署规则");
  assert.equal(
    (await f.call("/bridges/preview", "POST", { ids: ["@alice:test"] })).status,
    403,
  );
  const p = await plan(f, ["@telegram_bot:test"]);
  delete f.users.get("@telegram_bot:test").admin;
  const job = await finished(f, await start(f, p));
  assert.equal(job.status, "partial");
  assert.ok(!f.calls.some((c) => c.path.includes("/deactivate/")));
});

test("restart marks unfinished cleanup interrupted and never replays deletion", async (t) => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "tuwunel-restart-test-"));
  const data = JSON.parse(
    await readFile(join(f.app.directory, "state.json"), "utf8"),
  );
  data.cleanupJobs = {
    unfinished: {
      id: "unfinished",
      homeserver: f.origin,
      status: "running",
      targets: [signal],
      total: 1,
      processed: 0,
      results: [],
    },
  };
  data.mediaJobs = {
    unfinished: {
      id: "unfinished",
      homeserver: f.origin,
      status: "running",
      users: [{ userId: signal, status: "running", deleted: 100 }],
    },
  };
  await writeFile(join(directory, "state.json"), JSON.stringify(data));
  const restarted = await startRust({ homeserver: f.origin, directory });
  t.after(async () => {
    await restarted.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const disk = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  );
  assert.equal(disk.cleanupJobs.unfinished.status, "interrupted");
  assert.equal(disk.mediaJobs.unfinished.status, "interrupted");
  assert.equal(disk.mediaJobs.unfinished.users[0].deleted, 100);
  assert.match(disk.cleanupJobs.unfinished.message, /不会自动重放/);
  assert.ok(
    !f.calls.some(
      (c) => c.path.includes("/deactivate/") || c.method === "DELETE",
    ),
  );
});

test("media cleanup processes every batch for multiple users without deactivating accounts", async (t) => {
  const f = await fixture(t);
  f.media.set(
    signal,
    Array.from({ length: 251 }, (_, i) => "s" + i),
  );
  f.media.set(
    telegram,
    Array.from({ length: 113 }, (_, i) => "t" + i),
  );
  const started = await f.call("/media/jobs", "POST", {
    users: [signal, telegram],
    confirmation: "删除 2 位用户的全部媒体",
  });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  let job;
  for (let i = 0; i < 800; i++) {
    job = (await f.call("/media/jobs")).data.jobs.find(
      (j) => j.id === started.data.id,
    );
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(job.status, "complete", JSON.stringify(job));
  assert.deepEqual(
    job.users.map((u) => u.deleted).sort((a, b) => a - b),
    [113, 251],
  );
  assert.ok(job.users.every((u) => u.verified && u.remaining === 0));
  assert.equal(f.media.get(signal).length, 0);
  assert.equal(f.media.get(telegram).length, 0);
  assert.ok(!f.calls.some((c) => c.path.includes("/deactivate/")));
  assert.ok(
    f.calls
      .filter((c) => c.method === "DELETE")
      .every((c) => c.query.from === "0" && c.query.limit === "100"),
  );
});
test("media jobs enforce confirmation, local users, conflicts, cancellation and stalled progress", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call("/media/jobs", "POST", {
        users: [signal],
        confirmation: "yes",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("/media/jobs", "POST", {
        users: ["@a:foreign"],
        confirmation: "删除 1 位用户的全部媒体",
      })
    ).status,
    400,
  );
  f.media.set(
    signal,
    Array.from({ length: 1000 }, (_, i) => "s" + i),
  );
  const start = await f.call("/media/jobs", "POST", {
    users: [signal],
    confirmation: "删除 1 位用户的全部媒体",
  });
  assert.equal(start.status, 200);
  assert.equal(
    (
      await f.call("/media/jobs", "POST", {
        users: [telegram],
        confirmation: "删除 1 位用户的全部媒体",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.call("/media/jobs/cancel", "POST", { id: start.data.id })).status,
    200,
  );
  let job;
  for (let i = 0; i < 200; i++) {
    job = (await f.call("/media/jobs")).data.jobs.find(
      (j) => j.id === start.data.id,
    );
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(job.status, "canceled");
  assert.ok(f.media.get(signal).length > 0);
  f.setMediaFailure(true);
  const retry = await f.call("/media/jobs", "POST", {
    users: [telegram],
    confirmation: "删除 1 位用户的全部媒体",
  });
  for (let i = 0; i < 200; i++) {
    job = (await f.call("/media/jobs")).data.jobs.find(
      (j) => j.id === retry.data.id,
    );
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(job.status, "partial");
  assert.match(job.users[0].error, /未删除/);
  assert.equal((await f.client()("/media/jobs")).status, 401);
});
test("observability matches logged-in origin and Matrix server name and strips unapproved config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tuwunel-observer-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "snapshot.json");
  const f = await fixture(
    t,
    (origin) =>
      `[[observability.sources]]\nhomeserver="${origin}"\nsnapshot_file=${JSON.stringify(file)}`,
  );
  const snapshot = {
    schema: 1,
    homeserver: f.origin,
    server_name: "test",
    generated_at: Date.now(),
    metrics: null,
    history: [],
    configuration: {
      server_name: "test",
      registration_token: "NEVER-SHOW",
      unknown: "SECRET",
    },
    registrations: {
      available: false,
      truncated: false,
      since: null,
      invalid_lines: 0,
      ips: [],
      accounts: [],
    },
    diagnostics: [],
  };
  await writeFile(file, JSON.stringify(snapshot));
  let r = await f.call("/observability");
  assert.equal(r.status, 200);
  assert.equal(r.data.available, true);
  assert.equal(r.data.stale, false);
  assert.deepEqual(r.data.snapshot.configuration, { server_name: "test" });
  snapshot.generated_at -= 60000;
  await writeFile(file, JSON.stringify(snapshot));
  assert.equal((await f.call("/observability")).data.stale, true);
  snapshot.server_name = "different";
  await writeFile(file, JSON.stringify(snapshot));
  assert.equal((await f.call("/observability")).status, 502);
  snapshot.server_name = "test";
  snapshot.homeserver = "https://unrelated.example";
  await writeFile(file, JSON.stringify(snapshot));
  assert.equal((await f.call("/observability")).status, 502);
  assert.equal((await f.client()("/observability")).status, 401);
});

test("room directory preserves pagination and retains rooms whose metadata is unavailable", async (t) => {
  const f = await fixture(t);
  const r = await f.call("/rooms", "POST", { from: 0, search: "test" });
  assert.equal(r.status, 200);
  assert.equal(r.data.next_batch, 20);
  assert.equal(r.data.total_rooms, 42);
  assert.equal(r.data.rooms[0].avatar, "mxc://test/room");
  assert.equal(r.data.rooms[1].room_id, "!gone:test");
  assert.ok(r.data.rooms[1].avatarError);
  const upstream = f.calls.find((c) => c.path === "/_synapse/admin/v1/rooms");
  assert.equal(upstream.query.search_term, "test");
  assert.equal(upstream.query.limit, "20");
});
