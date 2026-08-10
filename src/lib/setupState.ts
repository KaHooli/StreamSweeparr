/**
 * Whether the app is configured enough to be useful, and what is missing.
 *
 * Pure logic (no I/O) so the dashboard's gate can be unit-tested, and so it
 * cannot drift from the validation `runSync` performs — which is the bug this
 * module exists to close. The dashboard used to demand a Watchmode key, a
 * country and a service outright, even though `runSync` requires those only
 * when a Sonarr connection is enabled and requires TMDB only when a Radarr one
 * is. A Radarr-only install therefore satisfied every requirement the sync
 * engine has and still sat on the "finish setup" screen for good, with no route
 * to the sweep button.
 *
 * The rule is per media type, mirroring `runSync`: enabled Sonarr connections
 * need the Watchmode stack, enabled Radarr connections need whichever stack
 * `movieProvider` names, and an install with neither kind of connection needs a
 * connection first. Movies pointed at Watchmode therefore need no TMDB key at
 * all — asking for one would be the same lockout in a new place.
 */

export interface SetupSettingsShape {
  watchmodeApiKeys: string[];
  countries: string[];
  serviceIds: number[];
  /** Which provider answers movie availability: "TMDB" | "WATCHMODE". */
  movieProvider: string;
  tmdbApiKey: string | null;
  tmdbRegions: string[];
  tmdbProviderIds: number[];
  connections: { type: string; enabled: boolean }[];
}

export interface SetupStatus {
  /** Nothing is missing — show the dashboard. */
  ready: boolean;
  /** Human-readable list of what still has to be configured. */
  missing: string[];
}

/**
 * What still stands between this install and a working sweep.
 *
 * Returned as a list rather than a boolean because the welcome screen should
 * say which half of the setup is outstanding: a user who has wired up Radarr
 * and TMDB but not Sonarr's Watchmode key is told exactly that, instead of
 * being shown the generic "you need everything" copy that sent Radarr-only
 * users looking for a Watchmode account they never needed.
 */
export function setupStatus(s: SetupSettingsShape): SetupStatus {
  const missing: string[] = [];

  const enabled = s.connections.filter((c) => c.enabled);
  if (!enabled.length) {
    missing.push("a Sonarr or Radarr connection");
    return { ready: false, missing };
  }

  // Only ask for the credentials the enabled connections actually consume —
  // the same split `runSync` makes before it validates anything, including the
  // movie provider, so that neither screen can demand a key the other doesn't.
  const sonarr = enabled.some((c) => c.type === "SONARR");
  const radarr = enabled.some((c) => c.type === "RADARR");
  const watchmodeMovies = radarr && s.movieProvider === "WATCHMODE";

  if (sonarr || watchmodeMovies) {
    // Name what the credential is for, so a movies-only install on Watchmode is
    // not sent looking for the TV setup it hasn't got.
    const forWhat = sonarr ? (watchmodeMovies ? "TV and movies" : "TV") : "movies";
    if (!s.watchmodeApiKeys.length) missing.push(`a Watchmode API key (for ${forWhat})`);
    if (!s.countries.length) missing.push(`at least one Watchmode country (for ${forWhat})`);
    if (!s.serviceIds.length) missing.push(`at least one streaming service (for ${forWhat})`);
  }

  if (radarr && !watchmodeMovies) {
    if (!s.tmdbApiKey) missing.push("a TheMovieDB API key (for movies)");
    if (!s.tmdbRegions.length) missing.push("at least one TMDB region (for movies)");
    if (!s.tmdbProviderIds.length) missing.push("at least one TMDB movie provider (for movies)");
  }

  return { ready: missing.length === 0, missing };
}
