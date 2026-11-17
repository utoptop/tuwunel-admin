// Synthetic loopback comparison. Usage: node scripts/benchmark.mjs /path/to/old-node-checkout
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, platform, arch, cpus } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { startRust } from "../tests/helpers.mjs";

const baseline = process.argv[2];
if (!baseline)
  throw new Error("Pass a checkout containing the original server/app.mjs");
const upstream = http.createServer((req, res) => {
  req.resume();
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify(
      req.url.includes("whoami")
        ? { user_id: "@admin:bench.test" }
        : req.url.includes("/users/@") || req.url.includes("/users/%40")
          ? { admin: true }
          : { users: [], total: 0 },
    ),
  );
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const homeserver = `http://127.0.0.1:${upstream.address().port}`;
const directory = await mkdtemp(join(tmpdir(), "tuwunel-node-bench-"));
let rust, node;
const concurrency = 32,
  requests = 5000,
  rounds = 3;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function rss(pid) {
  return (
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    ) / 1024
  );
}
async function run(base, route, headers = {}, body) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const url = new URL(route, base),
    bytes = body && JSON.stringify(body);
  const request = () =>
    new Promise((done, reject) => {
      const req = http.request(
        url,
        {
          agent,
          method: body ? "POST" : "GET",
          headers: {
            ...headers,
            ...(body
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(bytes),
                }
              : {}),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            res.statusCode === 200
              ? done()
              : reject(new Error(`HTTP ${res.statusCode}`)),
          );
        },
      );
      req.on("error", reject);
      req.end(bytes);
    });
  try {
    await Promise.all(Array.from({ length: concurrency }, request));
    let sent = 0;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (sent++ < requests) await request();
      }),
    );
    return requests / ((performance.now() - start) / 1000);
  } finally {
    agent.destroy();
  }
}
try {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {createApp}=await import(process.argv[1]);
    const {server}=createApp({homeserver:process.argv[2],dataDir:process.argv[3],publicUrl:'http://admin.test',scheduler:false});
    server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
  `,
      pathToFileURL(resolve(baseline, "server/app.mjs")).href,
      homeserver,
      directory,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  node = {
    child,
    base: await new Promise((done, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (b) => done(String(b).trim()));
    }),
  };
  rust = await startRust({
    homeserver,
    binary: resolve("target/release/tuwunel-admin"),
  });
  const result = {
    date: new Date().toISOString(),
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0].model,
      node: process.version,
    },
    concurrency,
    requests,
    rounds,
    results: {},
  };
  for (const [name, app] of [
    ["node", node],
    ["rust", rust],
  ]) {
    const response = await fetch(app.base + "/api/login", {
      method: "POST",
      headers: {
        origin: "http://admin.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ accessToken: "synthetic-benchmark-token" }),
    });
    const session = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(session));
    app.headers = {
      origin: "http://admin.test",
      cookie: response.headers.get("set-cookie").split(";")[0],
      "x-csrf-token": session.csrf,
    };
    result.results[name] = {
      idleRssMiB: rss(app.child.pid),
      healthRps: [],
      proxyRps: [],
    };
  }
  for (let i = 0; i < rounds; i++) {
    // Alternate order to reduce warm-up/order bias.
    for (const [name, app] of i % 2
      ? [
          ["rust", rust],
          ["node", node],
        ]
      : [
          ["node", node],
          ["rust", rust],
        ]) {
      result.results[name].healthRps.push(await run(app.base, "/api/health"));
      result.results[name].proxyRps.push(
        await run(app.base, "/api/admin", app.headers, {
          id: "users",
          params: {},
          query: { limit: 10 },
        }),
      );
    }
  }
  for (const [name, app] of [
    ["node", node],
    ["rust", rust],
  ]) {
    const r = result.results[name];
    r.loadedRssMiB = rss(app.child.pid);
    r.medianHealthRps = median(r.healthRps);
    r.medianProxyRps = median(r.proxyRps);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (rust) await rust.stop();
  if (node) {
    const done = once(node.child, "exit");
    node.child.kill();
    await done;
  }
  upstream.close();
  upstream.closeAllConnections();
  await rm(directory, { recursive: true, force: true });
}
