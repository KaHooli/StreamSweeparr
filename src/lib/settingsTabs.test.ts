import { describe, it, expect } from "vitest";
import { CONFIG_TABS, INFO_TAB, resolveTab, settingsTabs } from "./settingsTabs";

describe("settingsTabs", () => {
  it("puts Info last, and keeps it there as tabs are added", () => {
    const tabs = settingsTabs({ isAdmin: true });
    expect(tabs[tabs.length - 1].key).toBe("info");
    // The guarantee is structural, not a property of today's list: Info is
    // appended after CONFIG_TABS, so nothing added there can follow it.
    expect(CONFIG_TABS.some((t) => t.key === "info")).toBe(false);
    expect(tabs).toHaveLength(CONFIG_TABS.length + 1);
    expect(tabs.slice(0, -1).map((t) => t.key)).toEqual(CONFIG_TABS.map((t) => t.key));
  });

  it("hides Info from non-administrators", () => {
    const tabs = settingsTabs({ isAdmin: false });
    expect(tabs.some((t) => t.key === "info")).toBe(false);
    expect(tabs.map((t) => t.key)).toEqual(CONFIG_TABS.map((t) => t.key));
  });

  it("marks Info as the admin-only one", () => {
    expect(INFO_TAB.adminOnly).toBe(true);
    expect(CONFIG_TABS.every((t) => !t.adminOnly)).toBe(true);
  });
});

describe("resolveTab", () => {
  it("keeps a selection that is available", () => {
    expect(resolveTab("run", settingsTabs({ isAdmin: true }))).toBe("run");
    expect(resolveTab("info", settingsTabs({ isAdmin: true }))).toBe("info");
  });

  it("falls back to the first tab when the selection is not available", () => {
    // A non-admin (or an admin demoted mid-visit) must not be left on Info.
    expect(resolveTab("info", settingsTabs({ isAdmin: false }))).toBe("watchmode");
  });
});
