import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  HardDrive,
  LoaderCircle,
  ShieldCheck,
  StopCircle,
  Trash2,
} from "lucide-react";
import { request, bytes, fmtDate, type Data } from "./api";
import { Badge, Button, ErrorBox, Modal, Panel } from "./ui";

export function MediaCleanup({
  users,
  onClose,
  onStarted,
}: {
  users: Data[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const [value, setValue] = useState(""),
    [keepAvatar, setKeepAvatar] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const phrase = `删除 ${users.length} 位用户的全部媒体`;
  return (
    <Modal
      title="清理用户媒体"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body">
        <div className="destructive-banner">
          <span className="banner-icon">
            <Trash2 size={20} />
          </span>
          <div>
            <strong>
              {users.length} 位用户 ·{" "}
              {keepAvatar ? "清理非头像媒体直至清空" : "清理全部媒体（含头像）"}
            </strong>
            <p>
              {keepAvatar
                ? "将清理聊天附件、原图与缩略图，自动跳过并保留用户当前使用的头像文件。账号、消息与房间保留，但历史附件链接会失效。"
                : "将删除包括用户当前头像在内的全部媒体文件，清理后头像将无法显示。账号、消息与房间会保留。"}
            </p>
          </div>
        </div>

        <label className="switch-row">
          <span>
            <strong>
              <ShieldCheck size={15} className="inline-icon" />
              保留用户当前头像（推荐）
            </strong>
            <small>
              自动读取每位用户的 avatar_url，逐项跳过头像 MXC，避免清理后头像丢失。
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="保留用户当前头像"
            checked={keepAvatar}
            disabled={busy}
            onChange={(e) => setKeepAvatar(e.target.checked)}
          />
        </label>

        <div className="cleanup-targets">
          {users.map((u) => (
            <div className="cleanup-target" key={u.user_id}>
              <span className="target-icon">
                <HardDrive size={16} />
              </span>
              <div>
                <strong>{u.displayname || u.user_id}</strong>
                <code>{u.user_id}</code>
              </div>
              <span className="target-meta">
                {u.media_count === undefined
                  ? "全部媒体"
                  : u.media_length === undefined
                    ? `${u.media_count} 个文件`
                    : `${u.media_count} 个文件 · ${bytes(u.media_length)}`}
              </span>
            </div>
          ))}
        </div>

        <p className="notice">
          后台最多同时处理 3 位用户，持续清理全部非保护文件，不受单批 100
          个上限限制。可离开此页继续其他操作；退出登录会中断后续处理。
        </p>

        <label className="field">
          <span>输入「{phrase}」以确认不可撤销的删除</span>
          <input
            aria-label="全部媒体清理确认"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={phrase}
          />
        </label>
        <ErrorBox error={error} />
      </div>
      <div className="modal-foot">
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          kind="danger"
          disabled={busy || value !== phrase}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await request("/media/jobs", "POST", {
                users: users.map((u) => u.user_id),
                confirmation: phrase,
                keepAvatar,
              });
              window.dispatchEvent(new Event("media-jobs-updated"));
              onStarted();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Trash2 size={16} />
          )}
          {keepAvatar ? "开始清理（保留头像）" : "开始清理全部媒体"}
        </Button>
      </div>
    </Modal>
  );
}

export function MediaJobs({
  onRetry,
  onComplete,
}: {
  onRetry: (users: Data[]) => void;
  onComplete?: () => void;
}) {
  const [jobs, setJobs] = useState<Data[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>,
      previous = new Map<string, string>();
    const load = async () => {
      clearTimeout(timer);
      try {
        const data = await request("/media/jobs");
        if (active) {
          if (
            data.jobs.some(
              (j: Data) =>
                previous.get(j.id) === "running" && j.status !== "running",
            )
          )
            onComplete?.();
          previous = new Map(data.jobs.map((j: Data) => [j.id, j.status]));
          setJobs(data.jobs);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(load, 2500);
      }
    };
    load();
    window.addEventListener("media-jobs-updated", load);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("media-jobs-updated", load);
    };
  }, []);
  if (!jobs.length && !error) return null;
  return (
    <Panel
      title="媒体清理任务"
      subtitle="全量处理 · 逐人进度 · 最多 3 位用户并行"
    >
      <ErrorBox error={error} />
      <div className="job-list">
        {jobs.map((j) => {
          const complete = j.users.filter(
              (u: Data) => u.status === "complete",
            ).length,
            deleted = j.users.reduce((n: number, u: Data) => n + u.deleted, 0),
            preserved = j.users.reduce(
              (n: number, u: Data) => n + (u.preserved || 0),
              0,
            ),
            running = j.status === "running";
          return (
            <details
              className="job-card"
              key={j.id}
              open={running || undefined}
            >
              <summary>
                <span className={`job-state-icon ${j.status}`}>
                  {running ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : j.status === "complete" ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <AlertCircle size={17} />
                  )}
                </span>
                <div>
                  <strong>
                    已删除 {deleted.toLocaleString()} 个媒体文件
                    {preserved > 0 && ` · 已保留 ${preserved} 个头像`}
                  </strong>
                  <small>
                    {complete} / {j.users.length} 位用户完成 ·{" "}
                    {fmtDate(j.created)}
                  </small>
                </div>
                <div className="job-badges">
                  {j.keepAvatar !== false && (
                    <Badge tone="indigo">保留头像</Badge>
                  )}
                  <Badge
                    tone={
                      running
                        ? "amber"
                        : j.status === "complete"
                          ? "green"
                          : "red"
                    }
                  >
                    {
                      (
                        {
                          running: "运行中",
                          complete: "全部完成",
                          partial: "部分未完成",
                          canceled: "已取消",
                          interrupted: "已中断",
                        } as Data
                      )[j.status]
                    }
                  </Badge>
                </div>
              </summary>
              <div className="job-results">
                {j.users.map((u: Data) => (
                  <div className="job-row" key={u.userId}>
                    <code>{u.userId}</code>
                    <span className="job-row-meta">
                      {
                        (
                          {
                            pending: "等待中",
                            running: "清理中",
                            complete: "已清空",
                            failed: "未完成",
                          } as Data
                        )[u.status]
                      }{" "}
                      · 已删除 {u.deleted}
                      {u.preserved > 0 ? ` · 已保留头像 ${u.preserved}` : ""}
                      {u.remaining !== undefined &&
                      u.remaining !== null &&
                      u.remaining > 0
                        ? ` · 剩余 ${u.remaining}`
                        : ""}
                    </span>
                    {u.error && <ErrorBox error={u.error} />}
                  </div>
                ))}
              </div>
              {running ? (
                <div className="job-actions">
                  <Button
                    disabled={j.cancelRequested}
                    onClick={async () => {
                      try {
                        await request("/media/jobs/cancel", "POST", {
                          id: j.id,
                        });
                        window.dispatchEvent(new Event("media-jobs-updated"));
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <StopCircle size={15} />
                    {j.cancelRequested ? "正在停止…" : "停止后续清理"}
                  </Button>
                </div>
              ) : (
                complete < j.users.length && (
                  <div className="job-actions">
                    <Button
                      onClick={() =>
                        onRetry(
                          j.users
                            .filter((u: Data) => u.status !== "complete")
                            .map((u: Data) => ({ user_id: u.userId })),
                        )
                      }
                    >
                      继续清理未完成用户
                    </Button>
                  </div>
                )
              )}
            </details>
          );
        })}
      </div>
    </Panel>
  );
}
