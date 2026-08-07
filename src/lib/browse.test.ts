import { describe, it, expect } from "vitest";
import {
  RAIL_LETTERS,
  fold,
  letterAnchors,
  letterSpans,
  matchesSearch,
  searchHaystack,
  searchTerms,
  sortLetter,
} from "./browse";

describe("RAIL_LETTERS", () => {
  it("is '#' then A–Z, the order the grid sorts in", () => {
    expect(RAIL_LETTERS).toHaveLength(27);
    expect(RAIL_LETTERS[0]).toBe("#");
    expect(RAIL_LETTERS[RAIL_LETTERS.length - 1]).toBe("Z");
  });
});

describe("fold", () => {
  it("lowercases and strips accents so either spelling finds the other", () => {
    expect(fold("Pokémon")).toBe("pokemon");
    expect(fold("BØRNS")).toBe("børns"); // stroke isn't a combining mark; left alone
    expect(fold("Amélie")).toBe("amelie");
  });
});

describe("sortLetter", () => {
  it("buckets by the first character, like the grid's own ordering", () => {
    expect(sortLetter("A Christmas Carol")).toBe("A");
    // No article stripping: the grid sorts "The Office" under T, so does the rail.
    expect(sortLetter("The Office")).toBe("T");
    expect(sortLetter("  fargo")).toBe("F");
  });

  it("sends accented initials to their base letter", () => {
    expect(sortLetter("Élite")).toBe("E");
  });

  it("collects digits and punctuation under '#'", () => {
    expect(sortLetter("9-1-1")).toBe("#");
    expect(sortLetter("(500) Days of Summer")).toBe("#");
    expect(sortLetter("")).toBe("#");
  });
});

describe("searchTerms", () => {
  it("folds and splits on whitespace, dropping empties", () => {
    expect(searchTerms("  Pokémon   Netflix ")).toEqual(["pokemon", "netflix"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

const show = {
  title: "A Christmas Carol",
  year: 2019,
  services: [{ name: "Netflix" }, { name: "BINGE" }],
};

describe("searchHaystack", () => {
  it("covers the title, the year and the service names", () => {
    const hay = searchHaystack(show);
    expect(hay).toContain("christmas carol");
    expect(hay).toContain("2019");
    expect(hay).toContain("netflix");
  });

  it("tolerates a title with no year or services", () => {
    expect(searchHaystack({ title: "Andor" })).toBe("andor ");
  });
});

describe("matchesSearch", () => {
  it("matches on title, year or streaming service", () => {
    expect(matchesSearch(show, searchTerms("christmas"))).toBe(true);
    expect(matchesSearch(show, searchTerms("2019"))).toBe(true);
    expect(matchesSearch(show, searchTerms("binge"))).toBe(true);
  });

  it("requires every term, so a second word narrows the results", () => {
    expect(matchesSearch(show, searchTerms("carol netflix"))).toBe(true);
    expect(matchesSearch(show, searchTerms("carol disney"))).toBe(false);
  });

  it("ignores case and accents on both sides", () => {
    expect(matchesSearch({ title: "Pokémon" }, searchTerms("POKEMON"))).toBe(true);
  });

  it("matches everything when the query is empty", () => {
    expect(matchesSearch(show, [])).toBe(true);
  });
});

describe("letterAnchors", () => {
  it("points at the first item in each bucket", () => {
    const anchors = letterAnchors([
      { title: "9-1-1" },
      { title: "Andor" },
      { title: "Arcane" },
      { title: "Bluey" },
    ]);
    expect([...anchors]).toEqual([
      ["#", 0],
      ["A", 1],
      ["B", 3],
    ]);
  });

  it("indexes the list it is given, so a filtered grid lands on a visible card", () => {
    // "Andor" filtered out: A must now point at the first *shown* A title.
    const anchors = letterAnchors([{ title: "Arcane" }, { title: "Bluey" }]);
    expect(anchors.get("A")).toBe(0);
  });

  it("has no entry for a letter nothing starts with", () => {
    expect(letterAnchors([{ title: "Bluey" }]).has("Q")).toBe(false);
  });
});

describe("letterSpans", () => {
  const anchors = [
    { letter: "A", top: 0 },
    { letter: "B", top: 300 },
    { letter: "F", top: 400 },
  ];

  it("measures each bucket to the start of the next one", () => {
    const spans = letterSpans(anchors, 600);
    expect(spans.get("A")).toBe(300);
    expect(spans.get("B")).toBe(100);
  });

  it("runs the last bucket to the bottom of the grid", () => {
    expect(letterSpans(anchors, 600).get("F")).toBe(200);
  });

  it("keeps a bucket that measured nothing off zero, so it still gets a sliver", () => {
    // Two letters sharing one grid row, and an unlaid-out grid: neither should
    // end up with a flex-grow of 0 and vanish from the rail.
    const spans = letterSpans([{ letter: "A", top: 40 }, { letter: "B", top: 40 }], 40);
    expect(spans.get("A")).toBe(1);
    expect(spans.get("B")).toBe(1);
  });

  it("has nothing to say about a section with no anchors", () => {
    expect([...letterSpans([], 500)]).toEqual([]);
  });
});
