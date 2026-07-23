import { describe, it, expect } from "vitest";
import { flagEmoji } from "./flags";

describe("flagEmoji", () => {
  it("maps ISO codes to regional indicator flags", () => {
    expect(flagEmoji("US")).toBe("🇺🇸");
    expect(flagEmoji("gb")).toBe("🇬🇧"); // case-insensitive
  });

  it("returns a neutral flag for invalid input", () => {
    expect(flagEmoji("USA")).toBe("🏳️");
    expect(flagEmoji("1")).toBe("🏳️");
    expect(flagEmoji("")).toBe("🏳️");
  });
});
