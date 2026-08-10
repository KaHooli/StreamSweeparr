/**
 * The Settings tab strip.
 *
 * Lives here rather than inline in the page for one reason: **Info has to stay
 * last**. Expressing that as "a list of tabs, then Info appended" makes it
 * structural — a tab added to `CONFIG_TABS` can't land after Info, however far
 * down the list it's pasted — and lets a test hold the line.
 */

export type SettingsTabKey =
  | "watchmode"
  | "tmdb"
  | "connections"
  | "run"
  | "account"
  | "info";

export interface SettingsTab {
  key: SettingsTabKey;
  label: string;
  /** Hidden entirely from non-administrators. */
  adminOnly?: boolean;
}

/**
 * Configuration tabs, in display order. Add new ones here.
 *
 * The media-type labels the first two carried ("Watchmode (TV)", "TheMovieDB
 * (Movies)") stopped being true once movies could be answered by either
 * provider. Which one is in force is a setting, so each tab says so in its own
 * copy, where it can change with the setting, rather than in a fixed name.
 */
export const CONFIG_TABS: SettingsTab[] = [
  { key: "watchmode", label: "Watchmode" },
  { key: "tmdb", label: "Movies" },
  { key: "connections", label: "Connections" },
  { key: "run", label: "Run options" },
  { key: "account", label: "Users & security" },
];

/**
 * Diagnostics, not configuration — which is why it sits apart from the tabs
 * above and after all of them, and why it's admin-only: it reports the
 * database, the environment and the whole configuration in one place.
 */
export const INFO_TAB: SettingsTab = { key: "info", label: "Info", adminOnly: true };

/** The tabs this viewer may see, Info always last. */
export function settingsTabs(opts: { isAdmin: boolean }): SettingsTab[] {
  return [...CONFIG_TABS, INFO_TAB].filter((t) => !t.adminOnly || opts.isAdmin);
}

/** Fall back to the first tab when the selected one isn't available. */
export function resolveTab(selected: SettingsTabKey, tabs: SettingsTab[]): SettingsTabKey {
  return tabs.some((t) => t.key === selected) ? selected : tabs[0].key;
}
