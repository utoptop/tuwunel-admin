import { useState } from "react";
import { Moon, Sun, Monitor } from "lucide-react";
type Theme = "light" | "dark" | "system";
function saved(): Theme {
  try {
    const t = localStorage.getItem("tuwunel-theme");
    if (t === "light" || t === "dark") return t;
  } catch {}
  return "system";
}
function apply(theme: Theme) {
  document.documentElement.dataset.theme =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
}
apply(saved());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (saved() === "system") apply("system");
});
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(saved);
  const choices = [
    ["light", "浅色", Sun],
    ["dark", "深色", Moon],
    ["system", "跟随系统", Monitor],
  ] as const;
  return (
    <div className="theme-toggle" role="group" aria-label="外观模式">
      {choices.map(([key, label, Icon]) => (
        <button
          key={key}
          className={theme === key ? "active" : ""}
          title={label + "模式"}
          aria-label={label + "模式"}
          aria-pressed={theme === key}
          onClick={() => {
            setTheme(key);
            apply(key);
            try {
              localStorage.setItem("tuwunel-theme", key);
            } catch {}
          }}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
