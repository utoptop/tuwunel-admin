import { useState } from "react";
export default function Avatar({
  name,
  mxc,
  homeserver,
  large = false,
}: {
  name: string;
  mxc?: string;
  homeserver: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState("");
  const source = mxc?.startsWith("mxc://")
    ? "/api/avatar?" + new URLSearchParams({ mxc, homeserver })
    : "";
  const color = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return (
    <span className={`avatar tone-${color} ${large ? "large" : ""}`}>
      {source && failed !== source ? (
        <img
          key={source}
          src={source}
          alt={`${name} 的头像`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(source)}
        />
      ) : (
        <span aria-label={`${name} 默认头像`}>
          {[...name.replace(/^@/, "")][0]?.toUpperCase() || "?"}
        </span>
      )}
    </span>
  );
}
