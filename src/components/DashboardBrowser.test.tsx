// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import { DashboardBrowser } from "./DashboardBrowser";
import type { DashboardMovie, DashboardTvShow } from "@/lib/dashboard";

/**
 * The dashboard is the page people actually live in, and both features here are
 * "make a 400-title library navigable" — so what's worth testing is that the
 * search really narrows both grids, and that a rail letter jumps to a card that
 * is on screen rather than one the search just hid.
 */

const tvShow = (title: string, over: Partial<DashboardTvShow> = {}): DashboardTvShow => ({
  id: title.length * 1000 + title.charCodeAt(0),
  title,
  year: 2019,
  posterUrl: null,
  monitored: true,
  totalEpisodes: 6,
  monitoredEpisodes: 3,
  unmonitoredEpisodes: 3,
  streamingEpisodes: 6,
  unmonitoredPct: 50,
  tmdbId: 1,
  services: [{ name: "Netflix", type: "sub", logo: null, url: "https://netflix.test" }],
  lastSyncedAt: new Date(0),
  ...over,
});

const movie = (title: string, over: Partial<DashboardMovie> = {}): DashboardMovie => ({
  id: title.length * 100 + title.charCodeAt(0),
  title,
  year: 2001,
  posterUrl: null,
  monitored: false,
  hasFile: true,
  tmdbId: 2,
  services: [{ name: "BINGE", type: "sub", logo: null, url: "https://binge.test" }],
  lastSyncedAt: new Date(0),
  ...over,
});

const shows = [tvShow("A Christmas Carol"), tvShow("Andor"), tvShow("Bluey"), tvShow("Fargo")];
const movies = [movie("Arrival"), movie("Blade Runner"), movie("Dune")];

/**
 * Cards rendered in one section, by their title text. Walks forward from the
 * heading rather than using `~`, which would spill into the next section's grid
 * whenever this section renders an empty state instead of one.
 */
const titlesIn = (headingId: string): string[] => {
  let el = document.getElementById(headingId)?.nextElementSibling ?? null;
  while (el && !el.classList.contains("section-title")) {
    if (el.classList.contains("grid")) {
      return [...el.querySelectorAll(".poster-title")].map((t) => t.textContent ?? "");
    }
    el = el.nextElementSibling;
  }
  return [];
};

const railOf = (rail: "TV shows" | "movies") =>
  screen.getByRole("navigation", { name: `Jump to letter in ${rail}` });

/** A letter button in one of the two rails — TV's or the movies' own. */
const railButton = (rail: "TV shows" | "movies", letter: string) =>
  within(railOf(rail)).getByText(letter);

/** The letters a rail is currently offering, in order. */
const railLetters = (rail: "TV shows" | "movies") =>
  [...railOf(rail).querySelectorAll("button")].map((b) => b.textContent);

const rails = () => screen.queryAllByRole("navigation", { name: /jump to letter/i });

const search = () => screen.getByRole("searchbox");

let scrolledTo: HTMLElement[] = [];
/** Viewport position per element; jsdom reports 0 for everything by default. */
let tops: Map<Element, number>;
/** Bottom edge per element, for the grid the letter spans are measured against. */
let bottoms: Map<Element, number>;

beforeEach(() => {
  scrolledTo = [];
  tops = new Map();
  bottoms = new Map();
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolledTo.push(this as HTMLElement);
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    return { top: tops.get(this) ?? 0, bottom: bottoms.get(this) ?? 0 } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Put the movies heading below the fold, i.e. "reading the TV section", and let
 * the component's rAF-throttled scroll handler run.
 */
async function scrollToTop() {
  const heading = document.querySelector("#movies-on-streaming");
  if (heading) tops.set(heading, 900);
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
}

describe("DashboardBrowser search", () => {
  it("shows everything until something is typed", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    expect(titlesIn("tv-on-streaming")).toHaveLength(4);
    expect(titlesIn("movies-on-streaming")).toHaveLength(3);
  });

  it("filters both grids by title", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "a" } });
    expect(titlesIn("tv-on-streaming")).toEqual(["A Christmas Carol", "Andor", "Fargo"]);
    expect(titlesIn("movies-on-streaming")).toEqual(["Arrival", "Blade Runner"]);
  });

  it("finds titles by streaming service and by year", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "binge" } });
    expect(titlesIn("tv-on-streaming")).toEqual([]);
    expect(titlesIn("movies-on-streaming")).toHaveLength(3);

    fireEvent.change(search(), { target: { value: "2019" } });
    expect(titlesIn("tv-on-streaming")).toHaveLength(4);
    expect(titlesIn("movies-on-streaming")).toEqual([]);
  });

  it("treats a second word as a further narrowing, not a widening", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "andor netflix" } });
    expect(titlesIn("tv-on-streaming")).toEqual(["Andor"]);
    fireEvent.change(search(), { target: { value: "andor binge" } });
    expect(titlesIn("tv-on-streaming")).toEqual([]);
  });

  it("reports what matched, and says so when nothing does", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "a" } });
    expect(screen.getByRole("status").textContent).toBe("3 of 4 shows · 2 of 3 movies");
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toContain("Nothing on this page matches");
  });

  it("distinguishes 'nothing synced yet' from 'nothing matched'", () => {
    render(<DashboardBrowser tvShows={[]} movies={movies} />);
    expect(screen.getByText(/No TV episodes found/)).toBeTruthy();
    fireEvent.change(search(), { target: { value: "dune" } });
    // Still the sync hint for TV (there is nothing to search), a search miss for movies.
    expect(screen.getByText(/No TV episodes found/)).toBeTruthy();
    expect(titlesIn("movies-on-streaming")).toEqual(["Dune"]);
  });

  it("clears back to the full list", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "bluey" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(search()).toHaveProperty("value", "");
    expect(titlesIn("tv-on-streaming")).toHaveLength(4);
  });

  it("focuses on '/' from the page, but not while typing", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search());

    // A "/" typed into the box is a search term, not a shortcut.
    fireEvent.change(search(), { target: { value: "9-1" } });
    fireEvent.keyDown(search(), { key: "/" });
    expect(search()).toHaveProperty("value", "9-1");
  });

  it("clears on Escape", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "bluey" } });
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search()).toHaveProperty("value", "");
  });
});

describe("DashboardBrowser A–Z rails", () => {
  it("gives TV shows and movies a rail each", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    expect(rails().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Jump to letter in TV shows",
      "Jump to letter in movies",
    ]);
  });

  it("drops the rail for a section with nothing in it", () => {
    render(<DashboardBrowser tvShows={[]} movies={movies} />);
    expect(rails().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Jump to letter in movies",
    ]);
  });

  it("renders no rails at all when nothing has synced yet", () => {
    render(<DashboardBrowser tvShows={[]} movies={[]} />);
    expect(rails()).toEqual([]);
  });

  it("shows only the letters something starts with, in alphabetical order", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    // No "#", no Q — nothing starts with either, so neither is in the rail.
    expect(railLetters("TV shows")).toEqual(["A", "B", "F"]);
    expect(railLetters("movies")).toEqual(["A", "B", "D"]);
  });

  it("jumps to the first card under the letter in its own section", async () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    await scrollToTop();
    fireEvent.click(railButton("TV shows", "A"));
    expect(scrolledTo).toHaveLength(1);
    expect(scrolledTo[0].textContent).toContain("A Christmas Carol");

    // The same letter in the movies rail lands on the movie, not the show —
    // whichever section happens to be on screen.
    fireEvent.click(railButton("movies", "A"));
    expect(scrolledTo[1].textContent).toContain("Arrival");
  });

  it("reflects each section's own alphabet", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    // D is a movie-only letter, F a TV-only one: each appears in one rail only.
    expect(railLetters("TV shows")).toContain("F");
    expect(railLetters("TV shows")).not.toContain("D");
    expect(railLetters("movies")).toContain("D");
    expect(railLetters("movies")).not.toContain("F");
  });

  it("re-targets a letter at what the search left visible", async () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "andor" } });
    await scrollToTop();
    fireEvent.click(railButton("TV shows", "A"));
    // "A Christmas Carol" is filtered out, so A must land on Andor.
    expect(scrolledTo[0].textContent).toContain("Andor");
  });

  it("drops the letters the search filtered away", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "bluey" } });
    expect(railLetters("TV shows")).toEqual(["B"]);
  });

  it("drops a rail entirely when the search empties its section", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "bluey" } });
    // No movie matches, so there is no movie letter worth pointing at.
    expect(rails().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Jump to letter in TV shows",
    ]);
  });

  it("keeps titles starting with a digit reachable under '#'", async () => {
    render(<DashboardBrowser tvShows={[tvShow("9-1-1"), ...shows]} movies={movies} />);
    await scrollToTop();
    expect(railLetters("TV shows")).toEqual(["#", "A", "B", "F"]);
    fireEvent.click(railButton("TV shows", "#"));
    expect(scrolledTo[0].textContent).toContain("9-1-1");
  });

  it("highlights a letter only in the section being read", async () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    await scrollToTop();
    // Every TV anchor sits above the active line here, so the last one wins;
    // the movies rail highlights nothing, because that section is below the fold.
    expect(railButton("TV shows", "F").className).toContain("active");
    expect(rails()[1].querySelectorAll("button.active")).toHaveLength(0);
  });
});

describe("DashboardBrowser rail proportions", () => {
  /**
   * Lay the anchor cards out at known offsets and let the component measure
   * them. A: 300px of page, B: 100px, F: 200px — so the rail should hand A
   * three times the height of B, the way a scrollbar would.
   */
  async function layOutTv(offsets: Record<string, number>, gridBottom: number) {
    const anchors = [...document.querySelectorAll<HTMLElement>('[data-section="tv"][data-letter]')];
    for (const el of anchors) tops.set(el, offsets[el.dataset.letter ?? ""] ?? 0);
    const grid = anchors[0]?.closest(".grid");
    if (grid) bottoms.set(grid, gridBottom);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 32));
    });
  }

  const grow = (rail: "TV shows" | "movies", letter: string) =>
    Number(railButton(rail, letter).style.flexGrow);

  it("sizes each letter by how much of the page it covers", async () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    await layOutTv({ A: 0, B: 300, F: 400 }, 600);
    expect(grow("TV shows", "A")).toBe(300);
    expect(grow("TV shows", "B")).toBe(100);
    expect(grow("TV shows", "F")).toBe(200);
  });

  it("gives each rail the share of the column its section takes of the page", async () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    await layOutTv({ A: 0, B: 300, F: 400 }, 600);
    // The TV section measured 600px; the movies grid is unlaid-out here, so its
    // three letters fall back to a sliver each rather than to nothing.
    expect(Number(railOf("TV shows").style.flexGrow)).toBe(600);
    expect(Number(railOf("movies").style.flexGrow)).toBe(3);
  });

  it("falls back to equal letters before anything has been measured", () => {
    // What the server renders, and the first client paint: no layout to read.
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    expect(grow("TV shows", "A")).toBe(1);
    expect(grow("TV shows", "B")).toBe(1);
  });
});
