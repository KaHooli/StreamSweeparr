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

/** A letter button in one of the two rails — TV's or the movies' own. */
const railButton = (rail: "TV shows" | "movies", letter: string) =>
  within(screen.getByRole("navigation", { name: `Jump to letter in ${rail}` })).getByText(letter);

const rails = () => screen.queryAllByRole("navigation", { name: /jump to letter/i });

const search = () => screen.getByRole("searchbox");

let scrolledTo: HTMLElement[] = [];
/** Viewport position per element; jsdom reports 0 for everything by default. */
let tops: Map<Element, number>;

beforeEach(() => {
  scrolledTo = [];
  tops = new Map();
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolledTo.push(this as HTMLElement);
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    return { top: tops.get(this) ?? 0 } as DOMRect;
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

  it("offers '#' plus every letter, disabling the ones nothing starts with", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    expect(railButton("TV shows", "#")).toHaveProperty("disabled", true);
    expect(railButton("TV shows", "A")).toHaveProperty("disabled", false);
    expect(railButton("TV shows", "Q")).toHaveProperty("disabled", true);
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
    // D is a movie-only letter, F a TV-only one.
    expect(railButton("TV shows", "D")).toHaveProperty("disabled", true);
    expect(railButton("movies", "D")).toHaveProperty("disabled", false);
    expect(railButton("TV shows", "F")).toHaveProperty("disabled", false);
    expect(railButton("movies", "F")).toHaveProperty("disabled", true);
  });

  it("re-targets a letter at what the search left visible", async () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "andor" } });
    await scrollToTop();
    fireEvent.click(railButton("TV shows", "A"));
    // "A Christmas Carol" is filtered out, so A must land on Andor.
    expect(scrolledTo[0].textContent).toContain("Andor");
  });

  it("disables the letters the search filtered away", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "bluey" } });
    expect(railButton("TV shows", "A")).toHaveProperty("disabled", true);
    expect(railButton("TV shows", "B")).toHaveProperty("disabled", false);
  });

  it("keeps the rails up while a search empties one of them", () => {
    render(<DashboardBrowser tvShows={shows} movies={movies} />);
    fireEvent.change(search(), { target: { value: "bluey" } });
    // Every movie is filtered out, but its rail stays put rather than shifting
    // the TV rail out from under the pointer.
    expect(rails()).toHaveLength(2);
    expect(railButton("movies", "A")).toHaveProperty("disabled", true);
  });

  it("keeps titles starting with a digit reachable under '#'", async () => {
    render(<DashboardBrowser tvShows={[tvShow("9-1-1"), ...shows]} movies={movies} />);
    await scrollToTop();
    expect(railButton("TV shows", "#")).toHaveProperty("disabled", false);
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
