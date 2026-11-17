import { useEffect, useState } from "react";
import {
  HardDrive,
  LoaderCircle,
  StopCircle,
  Trash2,
  CheckCircle2,
  AlertCircle,
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const phrase = `删除 ${users.length} 位用户的全部媒体`;
  return (
    <Modal
      title="清理全部用户媒体"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body">
        <div className="destructive-banner">
          <Trash2 size={22} />
          <div>
            <strong>{users.length} 位用户 · 清理至没有剩余文件</strong>
            <p>
              包含附件、原图、缩略图与头像文件。账号、消息和房间会保留，但其中的媒体链接可能失效。
            </p>
          </div>
        </div>
        <div className="cleanup-targets">
          {users.map((u) => (
            <div className="cleanup-target" key={u.user_id}>
              <HardDrive size={18} />
              <div>
                <strong>{u.displayname || u.user_id}</strong>
                <code>{u.user_id}</code>
              </div>
              <span>
                {u.media_count === undefined
                  ? "全部媒体"
                  : `${u.media_count} 个文件 · ${bytes(u.media_length)}`}
              </span>
            </div>
          ))}
        </div>
        <p className="notice">
          后台最多同时清理 3 位用户，持续处理全部文件，不会在 100
          个文件处停止。可离开当前页面查看其他功能；退出登录会中断后续处理。上传持续进行时，清理也可能持续运行。
        </p>
        <label className="field">
          <span>输入「{phrase}」确认不可撤销的删除</span>
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
            try {
              await request("/media/jobs", "POST", {
                users: users.map((u) => u.user_id),
                confirmation: phrase,
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
          开始清理全部媒体
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
            running = j.status === "running";
          return (
            <details
              className="job-card"
              key={j.id}
              open={running || undefined}
            >
              <summary>
                {running ? (
                  <LoaderCircle className="spin" size={18} />
                ) : j.status === "complete" ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <AlertCircle size={18} />
                )}
                <div>
                  <strong>已删除 {deleted.toLocaleString()} 个媒体文件</strong>
                  <small>
                    {complete} / {j.users.length} 位用户完成 ·{" "}
                    {fmtDate(j.created)}
                  </small>
                </div>
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
              </summary>
              <div className="job-results">
                {j.users.map((u: Data) => (
                  <div className="job-row" key={u.userId}>
                    <code>{u.userId}</code>
                    <span>
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
                      {u.remaining !== undefined && u.remaining !== null
                        ? ` · 剩余 ${u.remaining}`
                        : ""}
                    </span>
                    {u.error && <ErrorBox error={u.error} />}
                  </div>
                ))}
              </div>
              {running ? (
                <Button
                  disabled={j.cancelRequested}
                  onClick={async () => {
                    try {
                      await request("/media/jobs/cancel", "POST", { id: j.id });
                      window.dispatchEvent(new Event("media-jobs-updated"));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <StopCircle size={15} />
                  {j.cancelRequested ? "正在停止…" : "停止后续清理"}
                </Button>
              ) : (
                complete < j.users.length && (
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
                )
              )}
            </details>
          );
        })}
      </div>
    </Panel>
  );
}
