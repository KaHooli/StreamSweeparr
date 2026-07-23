"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "system" | "dark" | "light";
const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeCtx);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");

  // Load persisted preference (defaults to "system" -> follows OS).
  useEffect(() => {
    const saved = (localStorage.getItem("ss-theme") as Theme) || "system";
    setThemeState(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("ss-theme", t);
    document.documentElement.setAttribute("data-theme", t);
  };

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const opts: { key: Theme; icon: string; title: string }[] = [
    { key: "light", icon: "☀", title: "Light" },
    { key: "dark", icon: "☾", title: "Dark" },
    { key: "system", icon: "◐", title: "System" },
  ];
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {opts.map((o) => (
        <button
          key={o.key}
          className={theme === o.key ? "active" : ""}
          onClick={() => setTheme(o.key)}
          title={o.title}
          aria-pressed={theme === o.key}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
