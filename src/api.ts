export type Session = {
  userId: string;
  csrf: string;
  homeserver: string;
  expires: number;
};
export type Endpoint = {
  id: string;
  group: string;
  label: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body?: unknown;
  note: string;
};
export type Data = Record<string, any>;
let csrf = "";
export function setSession(value: Session | null) {
  csrf = value?.csrf || "";
}
export async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/login" && path !== "/session")
      window.dispatchEvent(new Event("session-expired"));
    throw Object.assign(
      new Error(data.error || `请求失败 (${response.status})`),
      { status: response.status, code: data.errcode },
    );
  }
  return data;
}
export const admin = (
  id: string,
  params: Data = {},
  query: Data = {},
  body?: unknown,
  confirm = false,
) => request("/admin", "POST", { id, params, query, body, confirm });
export const fmtDate = (value: any) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const bytes = (value: number) =>
  !value
    ? "0 B"
    : value < 1024
      ? `${value} B`
      : value < 1048576
        ? `${(value / 1024).toFixed(1)} KB`
        : value < 1073741824
          ? `${(value / 1048576).toFixed(1)} MB`
          : `${(value / 1073741824).toFixed(2)} GB`;
