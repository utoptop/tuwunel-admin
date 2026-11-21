import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import Avatar from "./Avatar";
import { request, fmtDate, type Data, type Session } from "./api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Loading,
  Modal,
  Pagination,
  Panel,
  useLoad,
} from "./ui";

export function BridgeCleanup({
  selection,
  session,
  onClose,
  onStarted,
}: {
  selection: Data;
  session: Session;
  onClose: () => void;
  onStarted: () => void;
}) {
  const plan = useLoad(() => request("/bridges/preview", "POST", selection));
  const [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [from, setFrom] = useState(0);
  return (
    <Modal
      title="预览桥接用户清理"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body">
        <ErrorBox error={plan.error || error} />
        {plan.loading ? (
          <Loading />
        ) : (
          plan.data && (
            <>
              <div className="destructive-banner">
                <span className="banner-icon">
                  <AlertTriangle size={20} />
                </span>
                <div>
                  <strong>将清理 {plan.data.count} 个桥接用户</strong>
                  <p>
                    这是不可撤销的操作。请核对以下目标，并确认对应桥接服务已停止。
                  </p>
                </div>
              </div>
              <p className="notice">{plan.data.scope}</p>
              <p className="footnote cleanup-limits">{plan.data.limits}</p>
              <div className="cleanup-targets">
                {plan.data.users.slice(from, from + 20).map((u: Data) => (
                  <div className="user-room-row" key={u.name}>
                    <Avatar
                      name={u.displayname || u.name}
                      mxc={u.avatar_url}
                      homeserver={session.homeserver}
                    />
                    <div>
                      <strong>{u.displayname || u.name}</strong>
                      <code>{u.name}</code>
                      <small>
                        {u.bridge.name} · {u.bridge.source} · {u.bridge.rule}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
              <Pagination
                from={from}
                next={from + 20 < plan.data.count ? from + 20 : null}
                total={plan.data.count}
                onChange={setFrom}
              />
              <label className="field">
                <span>输入「{plan.data.confirmation}」确认清理</span>
                <input
                  aria-label="桥接清理确认文字"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder={plan.data.confirmation}
                />
              </label>
              <p className="footnote">
                预览有效期 10 分钟。清理完成后，已擦除的账号会自动归入「已擦除归档」视图（Matrix 协议会保留 ID 占位以防重用）。
              </p>
            </>
          )
        )}
      </div>
      <div className="modal-foot">
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          kind="danger"
          disabled={
            busy || !plan.data || confirmation !== plan.data.confirmation
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await request("/bridges/cleanup", "POST", {
                plan: plan.data!.plan,
                confirm: confirmation,
              });
              window.dispatchEvent(new Event("bridge-jobs-updated"));
              onStarted();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Trash2 size={16} />
          )}
          开始清理
        </Button>
      </div>
    </Modal>
  );
}

export function BridgeJobs({
  onRetry,
  onComplete,
}: {
  onRetry: (ids: string[]) => void;
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
        const result = await request("/bridges/jobs");
        if (active) {
          if (
            result.jobs.some(
              (j: Data) =>
                previous.get(j.id) === "running" && j.status !== "running",
            )
          ) {
            onComplete?.();
          }
          previous = new Map(result.jobs.map((j: Data) => [j.id, j.status]));
          setJobs(result.jobs);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(load, 3000);
      }
    };
    load();
    window.addEventListener("bridge-jobs-updated", load);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("bridge-jobs-updated", load);
    };
  }, []);
  if (!jobs.length && !error) return null;
  return (
    <Panel
      title="桥接清理记录"
      subtitle="保留逐个账号的执行与核验结果；失败或中断后可重新预览剩余目标"
    >
      <ErrorBox error={error} />
      <div className="job-list">
        {jobs.map((job) => {
          const completed = job.results.filter(
            (r: Data) => r.status === "complete",
          );
          const retry = job.targets.filter(
            (id: string) => !completed.some((r: Data) => r.user_id === id),
          );
          const running = job.status === "running";
          return (
            <details
              key={job.id}
              className="job-card"
              open={running || undefined}
            >
              <summary>
                <span className={`job-state-icon ${job.status}`}>
                  {running ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : job.status === "complete" ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <AlertTriangle size={17} />
                  )}
                </span>
                <div>
                  <strong>
                    {job.processed} / {job.total} 个桥接账号已处理
                  </strong>
                  <small>
                    {fmtDate(job.created)} · 已核实擦除 {completed.length} 个
                  </small>
                </div>
                <Badge
                  tone={
                    running
                      ? "amber"
                      : job.status === "complete"
                        ? "green"
                        : "red"
                  }
                >
                  {{
                    running: "清理中",
                    complete: "已完成",
                    partial: "部分失败",
                    interrupted: "已中断",
                  }[job.status as string] || job.status}
                </Badge>
              </summary>
              {job.message && <p className="notice">{job.message}</p>}
              <div className="job-results">
                {job.results.map((r: Data) => (
                  <div key={r.user_id} className="job-row">
                    <code>{r.user_id}</code>
                    <span className="job-row-meta">
                      {r.status === "complete"
                        ? "已擦除并核实"
                        : r.deactivated
                          ? "已停用，后续清理未完成"
                          : "未完成"}{" "}
                      · 删除 {r.mediaDeleted} 个媒体
                    </span>
                    {r.note && <small className="job-note">{r.note}</small>}
                    {r.error && <ErrorBox error={r.error} />}
                  </div>
                ))}
              </div>
              {!job.results.length && <Empty text="正在处理第一个账号…" />}
              {!running && retry.length > 0 && (
                <div className="job-actions">
                  <Button onClick={() => onRetry(retry)}>
                    重新预览未完成用户（{retry.length}）
                  </Button>
                </div>
              )}
            </details>
          );
        })}
      </div>
    </Panel>
  );
}
