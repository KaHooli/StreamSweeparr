import { describe, it, expect } from "vitest";
import {
  normalizeWatchmodeKeys,
  watchmodeKeys,
  resolveWatchmodeKeyEntries,
  WatchmodeKeyEntryError,
  watchmodeKeyEntriesSchema,
  MAX_WATCHMODE_KEYS,
} from "./watchmodeKeys";

describe("normalizeWatchmodeKeys", () => {
  it("trims, drops blanks and keeps order", () => {
    expect(normalizeWatchmodeKeys([" a ", "", "  ", "b", null, undefined])).toEqual(["a", "b"]);
  });

  it("drops duplicates, keeping the first position", () => {
    // A repeated key would make failover 'move on' to a key already spent.
    expect(normalizeWatchmodeKeys(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});

describe("watchmodeKeys", () => {
  it("uses the array when it has entries", () => {
    expect(watchmodeKeys({ watchmodeApiKeys: ["a", "b"], watchmodeApiKey: "a" })).toEqual([
      "a",
      "b",
    ]);
  });

  it("falls back to the legacy single key when the array is empty", () => {
    expect(watchmodeKeys({ watchmodeApiKeys: [], watchmodeApiKey: "legacy" })).toEqual(["legacy"]);
    expect(watchmodeKeys({ watchmodeApiKey: "legacy" })).toEqual(["legacy"]);
  });

  it("is empty when nothing is configured", () => {
    expect(watchmodeKeys({})).toEqual([]);
    expect(watchmodeKeys({ watchmodeApiKeys: [], watchmodeApiKey: null })).toEqual([]);
  });
});

describe("resolveWatchmodeKeyEntries", () => {
  const stored = ["one", "two", "three"];

  it("resolves kept positions and new values into one ordered ring", () => {
    const out = resolveWatchmodeKeyEntries(
      [{ keep: 1 }, { value: "new" }, { keep: 3 }],
      stored
    );
    expect(out).toEqual(["one", "new", "three"]);
  });

  it("removes a key by leaving its slot out, renumbering the rest", () => {
    expect(resolveWatchmodeKeyEntries([{ keep: 1 }, { keep: 3 }], stored)).toEqual([
      "one",
      "three",
    ]);
  });

  it("replaces a stored key in place", () => {
    expect(
      resolveWatchmodeKeyEntries([{ value: "replacement" }, { keep: 2 }, { keep: 3 }], stored)
    ).toEqual(["replacement", "two", "three"]);
  });

  it("reorders", () => {
    expect(resolveWatchmodeKeyEntries([{ keep: 2 }, { keep: 1 }], stored)).toEqual(["two", "one"]);
  });

  it("de-duplicates a newly typed key that is already in the ring", () => {
    expect(resolveWatchmodeKeyEntries([{ keep: 1 }, { value: "one" }], stored)).toEqual(["one"]);
  });

  it("rejects a slot pointing at a key that is no longer stored", () => {
    // The client is working from a stale view; dropping the slot silently would
    // delete a key the user believes they kept.
    expect(() => resolveWatchmodeKeyEntries([{ keep: 4 }], stored)).toThrow(
      WatchmodeKeyEntryError
    );
    expect(() => resolveWatchmodeKeyEntries([{ keep: 1 }], [])).toThrow(WatchmodeKeyEntryError);
  });

  it("allows an empty ring (every key removed)", () => {
    expect(resolveWatchmodeKeyEntries([], stored)).toEqual([]);
  });
});

describe("watchmodeKeyEntriesSchema", () => {
  it("accepts values and kept positions", () => {
    expect(watchmodeKeyEntriesSchema.safeParse([{ value: "k" }, { keep: 2 }]).success).toBe(true);
  });

  it("rejects empty values, zero positions and over-long rings", () => {
    expect(watchmodeKeyEntriesSchema.safeParse([{ value: "" }]).success).toBe(false);
    expect(watchmodeKeyEntriesSchema.safeParse([{ keep: 0 }]).success).toBe(false);
    const tooMany = Array.from({ length: MAX_WATCHMODE_KEYS + 1 }, (_, i) => ({ value: `k${i}` }));
    expect(watchmodeKeyEntriesSchema.safeParse(tooMany).success).toBe(false);
  });
});
