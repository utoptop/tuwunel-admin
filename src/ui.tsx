import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setData(undefined);
    fn()
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((v) => v + 1) };
}
export function Button({
  children,
  onClick,
  kind = "",
  disabled = false,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      className={`btn ${kind}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="empty">
      <LoaderCircle className="spin" size={24} />
      <span>正在读取服务器数据…</span>
    </div>
  );
}
export function Empty({ text = "暂无数据" }: { text?: string }) {
  return (
    <div className="empty">
      <span className="empty-symbol">∅</span>
      <span>{text}</span>
    </div>
  );
}
export function JsonView({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="json-wrap">
      <Button
        kind="icon copy"
        title="复制 JSON"
        onClick={() => {
          navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
      <pre>{text}</pre>
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  children,
  action,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Refresh({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      <RefreshCw size={15} />
      刷新
    </Button>
  );
}
export function Pagination({
  from,
  next,
  total,
  onChange,
}: {
  from: number;
  next?: any;
  total?: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total === undefined ? "分页结果" : `共 ${total.toLocaleString()} 项`} ·
        每页 20 项
      </span>
      <div>
        <Button
          kind="icon"
          title="上一页"
          disabled={!from}
          onClick={() => onChange(Math.max(0, from - 20))}
        >
          <ArrowLeft size={15} />
        </Button>
        <span>{Math.floor(from / 20) + 1}</span>
        <Button
          kind="icon"
          title="下一页"
          disabled={next === undefined || next === null}
          onClick={() => onChange(Number(next))}
        >
          <ArrowRight size={15} />
        </Button>
      </div>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div className="overlay">
      <div
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <Button kind="icon" title="关闭" onClick={onClose}>
            <X size={20} />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
export type Field = {
  key: string;
  label: string;
  type?: string;
  value?: any;
  required?: boolean;
  hint?: string;
  options?: [string, string][];
};
export type Operation = {
  title: string;
  description?: string;
  fields?: Field[];
  danger?: boolean;
  run: (values: Record<string, any>) => Promise<any>;
  onDone?: () => void;
  showResult?: boolean;
  submitLabel?: string;
};
export function ActionDialog({
  operation,
  onClose,
}: {
  operation: Operation;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, any>>(() =>
    Object.fromEntries(
      (operation.fields || []).map((f) => [
        f.key,
        f.value ?? (f.type === "checkbox" ? false : ""),
      ]),
    ),
  );
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>();
  return (
    <Modal
      title={operation.title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const r = await operation.run(values);
            operation.onDone?.();
            if (operation.showResult) setResult(r);
            else onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {operation.description && (
            <p className="notice">{operation.description}</p>
          )}
          {result === undefined ? (
            (operation.fields || []).map((f) => (
              <label
                className={`field ${f.type === "checkbox" ? "check-field" : ""}`}
                key={f.key}
              >
                {f.type === "checkbox" ? (
                  <>
                    <input
                      type="checkbox"
                      checked={Boolean(values[f.key])}
                      onChange={(e) =>
                        setValues({ ...values, [f.key]: e.target.checked })
                      }
                    />
                    <span>{f.label}</span>
                  </>
                ) : (
                  <>
                    <span>{f.label}</span>
                    {f.type === "textarea" ? (
                      <textarea
                        required={f.required}
                        value={values[f.key]}
                        onChange={(e) =>
                          setValues({ ...values, [f.key]: e.target.value })
                        }
                      />
                    ) : f.options ? (
                      <select
                        value={values[f.key]}
                        onChange={(e) =>
                          setValues({ ...values, [f.key]: e.target.value })
                        }
                      >
                        {f.options.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        required={f.required}
                        type={f.type || "text"}
                        value={values[f.key]}
                        autoComplete={
                          f.type === "password" ? "new-password" : "off"
                        }
                        onChange={(e) =>
                          setValues({
                            ...values,
                            [f.key]:
                              f.type === "number"
                                ? e.target.value === ""
                                  ? ""
                                  : Number(e.target.value)
                                : e.target.value,
                          })
                        }
                      />
                    )}
                  </>
                )}
                {f.hint && <small>{f.hint}</small>}
              </label>
            ))
          ) : (
            <JsonView value={result} />
          )}
          {operation.danger && result === undefined && (
            <label className="field">
              <span>此操作会修改或删除服务器数据。输入「确认」继续</span>
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                placeholder="确认"
                required
              />
            </label>
          )}
          <ErrorBox error={error} />
        </div>
        <div className="modal-foot">
          <Button onClick={onClose} disabled={busy}>
            {result === undefined ? "取消" : "关闭"}
          </Button>
          {result === undefined && (
            <Button
              type="submit"
              kind={operation.danger ? "danger" : "primary"}
              disabled={busy || (operation.danger && confirmation !== "确认")}
            >
              {busy && <LoaderCircle size={16} className="spin" />}
              {operation.submitLabel || "确认执行"}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
