"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Poster } from "./Poster";
import {
  RAIL_LETTERS,
  letterAnchors,
  matchesSearch,
  searchTerms,
  sortLetter,
} from "@/lib/browse";
import type {
  DashboardMovie,
  DashboardService,
  DashboardTvShow,
} from "@/lib/dashboard";

type Section = "tv" | "movie";

/**
 * The line below the sticky topbar that decides "what am I looking at": the
 * section and letter whose heading has most recently crossed it are the ones
 * the rail highlights.
 */
const ACTIVE_LINE = 140;

/**
 * How much of a show is unmonitored, in words:
 *  - every episode unmonitored -> "Show unmonitored"
 *  - some episodes unmonitored -> "N episodes unmonitored"
 *  - none                      -> "Fully monitored"
 */
function unmonitoredLabel(s: DashboardTvShow): string {
  if (s.totalEpisodes > 0 && s.unmonitoredEpisodes >= s.totalEpisodes) return "Show unmonitored";
  if (s.unmonitoredEpisodes === 0) return "Fully monitored";
  const n = s.unmonitoredEpisodes;
  return `${n} ${n === 1 ? "episode" : "episodes"} unmonitored`;
}

/**
 * The streaming services a title was matched on, as logos linking to the title
 * on that service: a deep link where we have one, otherwise that service's
 * search page for the title (see `dedupeServices` for the full order).
 */
function ProviderLogos({ services, title }: { services: DashboardService[]; title: string }) {
  if (!services.length) return null;
  return (
    <div className="providers">
      {services.map((sv) => {
        const label = `${title} on ${sv.name}`;
        const inner = sv.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="provider-logo" src={sv.logo} alt={sv.name} title={label} loading="lazy" />
        ) : (
          <span className="chip" title={label}>
            {sv.name}
          </span>
        );
        return sv.url ? (
          <a
            key={sv.name}
            href={sv.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            className="provider-link"
          >
            {inner}
          </a>
        ) : (
          <span key={sv.name} className="provider-link" aria-label={label}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}

/** `N of M shows` while filtering, plain `M shows` otherwise. */
function countLabel(shown: number, total: number, noun: string): string {
  const plural = `${noun}${total === 1 ? "" : "s"}`;
  return shown === total ? `${total} ${plural}` : `${shown} of ${total} ${plural}`;
}

/**
 * The searchable, jumpable half of the dashboard: the search box, both media
 * grids, and the A–Z rail beside them.
 *
 * Filtering is client-side on purpose. The page already ships every on-streaming
 * title to the browser to render the grids, so searching them is instant and
 * costs no round trip — and a library big enough for that to hurt is a library
 * where scrolling was already the problem the rail solves.
 */
export function DashboardBrowser({
  tvShows,
  movies,
}: {
  tvShows: DashboardTvShow[];
  movies: DashboardMovie[];
}) {
  const [query, setQuery] = useState("");
  // Typing stays responsive on big libraries: the grids re-filter at their own
  // pace while the input updates immediately.
  const deferredQuery = useDeferredValue(query);
  const [activeSection, setActiveSection] = useState<Section>("tv");
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const moviesHeadingRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const terms = useMemo(() => searchTerms(deferredQuery), [deferredQuery]);
  const shownTv = useMemo(
    () => (terms.length ? tvShows.filter((s) => matchesSearch(s, terms)) : tvShows),
    [tvShows, terms]
  );
  const shownMovies = useMemo(
    () => (terms.length ? movies.filter((m) => matchesSearch(m, terms)) : movies),
    [movies, terms]
  );

  const tvAnchors = useMemo(() => letterAnchors(shownTv), [shownTv]);
  const movieAnchors = useMemo(() => letterAnchors(shownMovies), [shownMovies]);

  // Which section a letter jumps into: the one you're reading, if it has that
  // letter — otherwise the other one, so a letter is never a dead button.
  const sectionForLetter = useCallback(
    (letter: string): Section | null => {
      const inTv = tvAnchors.has(letter);
      const inMovies = movieAnchors.has(letter);
      if (activeSection === "movie") return inMovies ? "movie" : inTv ? "tv" : null;
      return inTv ? "tv" : inMovies ? "movie" : null;
    },
    [activeSection, tvAnchors, movieAnchors]
  );

  // Track what's on screen: the section, and the last letter heading to have
  // scrolled past the active line.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const root = containerRef.current;
      if (!root) return;
      const moviesTop = moviesHeadingRef.current?.getBoundingClientRect().top ?? Infinity;
      const section: Section = moviesTop <= ACTIVE_LINE ? "movie" : "tv";
      setActiveSection(section);
      const anchors = root.querySelectorAll<HTMLElement>(
        `[data-section="${section}"][data-letter]`
      );
      let current: string | null = null;
      for (const el of anchors) {
        if (el.getBoundingClientRect().top > ACTIVE_LINE) break;
        current = el.dataset.letter ?? null;
      }
      setActiveLetter(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // Re-measure when filtering changes what's rendered.
  }, [shownTv, shownMovies]);

  // "/" focuses the search from anywhere on the page, the way it does in the
  // apps this sits next to.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) {
        return;
      }
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const jumpTo = (letter: string) => {
    const section = sectionForLetter(letter);
    const root = containerRef.current;
    if (!section || !root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-section="${section}"][data-letter="${letter}"]`
    );
    if (!target) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  const filtering = terms.length > 0;
  const totalShown = shownTv.length + shownMovies.length;

  return (
    <div className="browse">
      <div className="browse-main" ref={containerRef}>
        <div className="card searchbar">
          <div className="searchbar-row">
            <label className="sr-only" htmlFor="dashboard-search">
              Search titles and streaming services
            </label>
            <input
              id="dashboard-search"
              ref={inputRef}
              className="input"
              type="search"
              value={query}
              placeholder="Search this page — title, year or streaming service…"
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
            />
            {filtering && (
              <button type="button" className="btn sm ghost" onClick={() => setQuery("")}>
                Clear
              </button>
            )}
          </div>
          <p className="muted searchbar-status" role="status">
            {filtering
              ? totalShown === 0
                ? `Nothing on this page matches “${deferredQuery.trim()}”.`
                : `${countLabel(shownTv.length, tvShows.length, "show")} · ` +
                  `${countLabel(shownMovies.length, movies.length, "movie")}`
              : "Press / to search. Use the A–Z rail to jump through the list."}
          </p>
        </div>

        {/* -------- TV shows -------- */}
        <div className="section-title" id="tv-on-streaming">
          <h2>TV shows on streaming</h2>
          <span className="count">{countLabel(shownTv.length, tvShows.length, "show")}</span>
        </div>
        {tvShows.length === 0 ? (
          <div className="empty card">
            No TV episodes found on your selected services yet. Run a sync.
          </div>
        ) : shownTv.length === 0 ? (
          <div className="empty card">No TV shows match your search.</div>
        ) : (
          <div className="grid">
            {shownTv.map((s, i) => {
              const letter = sortLetter(s.title);
              const isAnchor = tvAnchors.get(letter) === i;
              return (
                <div
                  className="poster-card"
                  key={s.id}
                  data-section={isAnchor ? "tv" : undefined}
                  data-letter={isAnchor ? letter : undefined}
                >
                  <Poster src={s.posterUrl} title={s.title} />
                  <div className="poster-body">
                    <p className="poster-title">{s.title}</p>
                    <span className="poster-year">{s.year ?? ""}</span>
                    <div className="progress">
                      <div className="row">
                        <span>{unmonitoredLabel(s)}</span>
                        <span>{s.unmonitoredPct}%</span>
                      </div>
                      <div className="track">
                        <div className="fill" style={{ width: `${s.unmonitoredPct}%` }} />
                      </div>
                      <div className="row" style={{ marginTop: 4 }}>
                        <span>
                          {s.streamingEpisodes}/{s.totalEpisodes} on streaming
                        </span>
                      </div>
                    </div>
                    <ProviderLogos services={s.services} title={s.title} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* -------- Movies -------- */}
        <div className="section-title" id="movies-on-streaming" ref={moviesHeadingRef}>
          <h2>Movies on streaming</h2>
          <span className="count">{countLabel(shownMovies.length, movies.length, "movie")}</span>
        </div>
        {movies.length === 0 ? (
          <div className="empty card">
            No movies found on your selected services yet. Run a sync.
          </div>
        ) : shownMovies.length === 0 ? (
          <div className="empty card">No movies match your search.</div>
        ) : (
          <div className="grid">
            {shownMovies.map((m, i) => {
              const letter = sortLetter(m.title);
              const isAnchor = movieAnchors.get(letter) === i;
              return (
                <div
                  className="poster-card"
                  key={m.id}
                  data-section={isAnchor ? "movie" : undefined}
                  data-letter={isAnchor ? letter : undefined}
                >
                  <Poster src={m.posterUrl} title={m.title} />
                  <div className="poster-body">
                    <p className="poster-title">{m.title}</p>
                    <span className="poster-year">{m.year ?? ""}</span>
                    <div>
                      <span className={`badge ${m.monitored ? "unmon" : "mon"}`}>
                        <span className="dot" />
                        {m.monitored ? "Monitored" : "Unmonitored"}
                      </span>
                    </div>
                    <ProviderLogos services={m.services} title={m.title} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <nav className="alpha-rail" aria-label="Jump to letter">
        {RAIL_LETTERS.map((letter) => {
          const target = sectionForLetter(letter);
          const isActive = activeLetter === letter && !!target;
          return (
            <button
              key={letter}
              type="button"
              className={isActive ? "active" : undefined}
              disabled={!target}
              aria-current={isActive ? "true" : undefined}
              aria-label={
                target
                  ? `Jump to ${letter === "#" ? "titles starting with a number or symbol" : letter}`
                  : `No titles under ${letter}`
              }
              onClick={() => jumpTo(letter)}
            >
              {letter}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
