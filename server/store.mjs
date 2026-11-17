import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export class Store {
  constructor(directory, encryptionKey) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "state.json");
    const keyfile = join(directory, "encryption.key");
    if (encryptionKey) this.key = Buffer.from(encryptionKey, "base64");
    else {
      if (!existsSync(keyfile))
        writeFileSync(keyfile, randomBytes(32), { mode: 0o600, flag: "wx" });
      this.key = readFileSync(keyfile);
    }
    if (this.key.length !== 32)
      throw new Error("ENCRYPTION_KEY 必须是 32 字节的 base64");
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : { policy: null, audit: [] };
    // Fail closed on corrupt state instead of silently discarding a configured policy.
    if (!Array.isArray(this.state.audit)) throw new Error("数据文件格式无效");
  }
  save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state), {
      mode: 0o600,
    });
    chmodSync(this.file + ".tmp", 0o600);
    renameSync(this.file + ".tmp", this.file);
  }
  seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
  }
  unseal(value) {
    const data = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  audit(actor, action, target = "", status = "success") {
    this.state.audit.unshift({
      id: randomBytes(8).toString("hex"),
      at: new Date().toISOString(),
      actor,
      action,
      target,
      status,
    });
    this.state.audit = this.state.audit.slice(0, 2000);
    this.save();
  }
  publicPolicy() {
    const { credential, ...policy } = this.state.policy || {
      enabled: false,
      localDays: 90,
      remoteDays: 30,
      intervalHours: 24,
      sizeGt: 0,
      keepProfiles: true,
    };
    return { ...policy, hasCredential: Boolean(credential) };
  }
}
