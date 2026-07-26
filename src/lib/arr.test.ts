import { describe, it, expect } from "vitest";
import { resolveSkipTagIds, hasSkipTag, SKIP_TAG_LABEL } from "./arr";

describe("resolveSkipTagIds", () => {
  it("matches the skip label case-insensitively", () => {
    const tags = [
      { id: 1, label: "4k" },
      { id: 2, label: "SS-Skip" },
      { id: 3, label: "kids" },
    ];
    expect([...resolveSkipTagIds(tags)]).toEqual([2]);
  });

  it("ignores surrounding whitespace", () => {
    expect([...resolveSkipTagIds([{ id: 9, label: "  ss-skip  " }])]).toEqual([9]);
  });

  it("collects every tag sharing the label", () => {
    const ids = resolveSkipTagIds([
      { id: 4, label: "ss-skip" },
      { id: 7, label: "SS-SKIP" },
    ]);
    expect(ids.has(4)).toBe(true);
    expect(ids.has(7)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("returns nothing for unrelated, empty or missing tag lists", () => {
    expect(resolveSkipTagIds([{ id: 1, label: "anime" }]).size).toBe(0);
    expect(resolveSkipTagIds([]).size).toBe(0);
    expect(resolveSkipTagIds(undefined).size).toBe(0);
    expect(resolveSkipTagIds(null).size).toBe(0);
  });

  it("does not match near-misses", () => {
    expect(resolveSkipTagIds([{ id: 1, label: "ss-skipped" }]).size).toBe(0);
    expect(resolveSkipTagIds([{ id: 2, label: "skip" }]).size).toBe(0);
  });

  it("uses ss-skip as the documented default label", () => {
    expect(SKIP_TAG_LABEL).toBe("ss-skip");
  });
});

describe("hasSkipTag", () => {
  const skipIds = new Set([2, 7]);

  it("is true when the title carries a skip tag", () => {
    expect(hasSkipTag([1, 2], skipIds)).toBe(true);
    expect(hasSkipTag([7], skipIds)).toBe(true);
  });

  it("is false otherwise", () => {
    expect(hasSkipTag([1, 3], skipIds)).toBe(false);
    expect(hasSkipTag([], skipIds)).toBe(false);
    expect(hasSkipTag(undefined, skipIds)).toBe(false);
    expect(hasSkipTag(null, skipIds)).toBe(false);
  });

  it("is false when the instance has no skip tag at all", () => {
    expect(hasSkipTag([1, 2, 3], new Set())).toBe(false);
  });
});
