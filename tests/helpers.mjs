import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function startRust(options = {}) {
  const owned = !options.directory;
  const directory =
    options.directory || (await mkdtemp(join(tmpdir(), "tuwunel-rust-test-")));
  const config = join(directory, "test.toml");
  const text = `[server]
listen = "127.0.0.1:${options.port || 0}"
public_url = ${JSON.stringify(options.publicUrl || "http://admin.test")}
cookie_secure = ${options.secureCookie || false}
static_dir = ${JSON.stringify(resolve("dist"))}
[matrix]
homeserver = ${JSON.stringify(options.homeserver || "")}
locked = ${options.locked ?? true}
allowed_homeservers = ${JSON.stringify(options.allowed || [])}
[auth]
allowed_origins = ${JSON.stringify(options.authAllowed || [])}
clients = ${options.authClient ? `[{ issuer = ${JSON.stringify(options.authClient.issuer)}, client_id = ${JSON.stringify(options.authClient.id)} }]` : "[]"}
[storage]
data_dir = ${JSON.stringify(directory)}
[limits]
login_attempts = ${options.loginAttempts || 10}
[scheduler]
enabled = ${options.scheduler || false}
poll_seconds = 1
${options.extraConfig || ""}
`;
  await writeFile(config, text);
  const child = spawn(
    options.binary || resolve("target/debug/tuwunel-admin"),
    ["--config", config],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Rust startup timed out: " + stderr));
    }, 15000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Rust exited: " + stderr));
    });
    child.stdout.on("data", (b) => {
      stdout += b;
      const match = /http:\/\/(127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve("http://" + match[1]);
      }
    });
  });
  return {
    base,
    directory,
    child,
    config,
    async stop() {
      if (child.exitCode === null) {
        const done = once(child, "exit");
        child.kill("SIGTERM");
        await done;
      }
      if (owned) await rm(directory, { recursive: true, force: true });
    },
  };
}
