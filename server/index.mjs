import { createApp } from "./app.mjs";
const { server } = createApp({
  homeserver: process.env.MATRIX_HOMESERVER_URL,
  publicUrl: process.env.PUBLIC_URL,
  dataDir: process.env.DATA_DIR || "./data",
  encryptionKey: process.env.ENCRYPTION_KEY,
  secureCookie: process.env.COOKIE_SECURE === "true",
});
const port = Number(process.env.PORT || 8080);
server.listen(port, process.env.HOST || "0.0.0.0", () =>
  console.log(`Tuwunel Admin 1.0 · http://localhost:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
