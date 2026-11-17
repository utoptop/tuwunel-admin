import { matrix, verifyAdmin, HttpError } from "./matrix.mjs";
import { buildRequest } from "./catalog.mjs";

export function validatePolicy(input) {
  const policy = {};
  for (const key of ["enabled", "keepProfiles"]) {
    if (typeof input[key] !== "boolean")
      throw new HttpError(400, `无效策略参数：${key}`);
    policy[key] = input[key];
  }
  for (const [key, min, max] of [
    ["localDays", 1, 36500],
    ["remoteDays", 1, 36500],
    ["intervalHours", 1, 8760],
    ["sizeGt", 0, Number.MAX_SAFE_INTEGER],
  ]) {
    if (
      !Number.isSafeInteger(input[key]) ||
      input[key] < min ||
      input[key] > max
    )
      throw new HttpError(400, `策略参数超出范围：${key}`);
    policy[key] = input[key];
  }
  return policy;
}

export class PolicyRunner {
  constructor(store, homeserver) {
    this.store = store;
    this.homeserver = homeserver;
    this.busy = false;
  }
  async run(force = false) {
    const policy = this.store.state.policy;
    if (this.busy) throw new HttpError(409, "媒体清理正在执行");
    if (!policy?.enabled) {
      if (force) throw new HttpError(400, "请先保存并启用策略");
      return;
    }
    if (!force && Date.now() < policy.nextRun) return;
    if (policy.homeserver !== this.homeserver)
      throw new HttpError(409, "上游服务器已变化，请重新配置生命周期策略");
    this.busy = true;
    const started = Date.now();
    const results = {};
    try {
      const token = this.store.unseal(policy.credential);
      await verifyAdmin(this.homeserver, token);
      for (const [id, days] of [
        ["deleteOldMedia", policy.localDays],
        ["purgeRemote", policy.remoteDays],
      ]) {
        const query = { before_ts: started - days * 86400000 };
        if (id === "deleteOldMedia")
          Object.assign(query, {
            size_gt: policy.sizeGt,
            keep_profiles: policy.keepProfiles,
          });
        const req = buildRequest(id, {}, query, {});
        const response = await matrix(
          this.homeserver,
          token,
          req.method,
          req.path,
          req.body,
        );
        // Retain counts only, never credentials or lists of individual media IDs.
        results[id] = response.total ?? response.deleted ?? 0;
      }
      policy.lastResult = { ok: true, counts: results };
      this.store.audit(policy.owner, "媒体生命周期清理", this.homeserver);
    } catch (error) {
      policy.lastResult = {
        ok: false,
        counts: results,
        error:
          error instanceof HttpError
            ? error.message
            : "策略凭据无法解密，请重新保存",
      };
      this.store.audit(
        policy.owner,
        "媒体生命周期清理",
        this.homeserver,
        "failed",
      );
    } finally {
      policy.lastRun = started;
      policy.nextRun = Date.now() + policy.intervalHours * 3600000;
      this.busy = false;
      this.store.save();
    }
    return this.store.publicPolicy();
  }
}
