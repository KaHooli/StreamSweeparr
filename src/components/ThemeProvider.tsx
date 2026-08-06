"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

type Theme = "system" | "dark" | "light";

const STORAGE_KEY = "ss-theme";

/**
 * The stored theme preference, treated as what it actually is: an external
 * store that lives outside React.
 *
 * It cannot be read during render — the server has no `localStorage`, and
 * reading it in a state initialiser would make the server and client disagree
 * about the first paint. Reading it in an effect and calling `setState` would
 * work but commits one render with the wrong theme first, which is the flash of
 * the wrong colours you sometimes see on themed sites. `useSyncExternalStore`
 * is the primitive for exactly this: a server snapshot for SSR, a client
 * snapshot read at the right moment, and a subscription for later changes.
 */
const themeStore = {
  listeners: new Set<() => void>(),

  subscribe(listener: () => void) {
    themeStore.listeners.add(listener);
    // Another tab changing the preference should update this one too.
    window.addEventListener("storage", listener);
    return () => {
      themeStore.listeners.delete(listener);
      window.removeEventListener("storage", listener);
    };
  },

  getSnapshot(): Theme {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Theme) || "system";
    } catch {
      // Private-mode browsers can throw on localStorage access.
      return "system";
    }
  },

  /** The server has no preference to read, so it renders the default. */
  getServerSnapshot(): Theme {
    return "system";
  },

  set(theme: Theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not persisting is survivable; the rest of the update still applies.
    }
    for (const listener of themeStore.listeners) listener();
  },
};

const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeCtx);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    themeStore.getServerSnapshot
  );

  const setTheme = useCallback((t: Theme) => themeStore.set(t), []);

  // The attribute drives the CSS, and has to track whatever the store says —
  // including a change made in another tab.
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
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
