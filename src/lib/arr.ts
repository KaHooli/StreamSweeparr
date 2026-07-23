/**
 * Clients for Sonarr v3 and Radarr v3, plus optional Seerr discovery.
 *
 * These talk directly to the *arr APIs which is the only way to toggle
 * episode-level monitoring and delete files. Seerr is used purely to discover
 * configured Sonarr/Radarr instances when the user does not enter them by hand.
 */

import { safeFetch } from "./safeFetch";

export class ArrError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ArrError";
  }
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function arrFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${normalizeBase(baseUrl)}${path}`;
  // safeFetch validates the host (SSRF guard) and applies a timeout.
  const res = await safeFetch(url, {
    ...init,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) {
    throw new ArrError(`Authentication failed for ${url} (check API key).`, res.status);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ArrError(`Request failed ${res.status} ${url}: ${body.slice(0, 200)}`, res.status);
  }
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* ------------------------------- Sonarr -------------------------------- */

export interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  monitored: boolean;
  tvdbId?: number;
  imdbId?: string;
  tmdbId?: number;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  statistics?: { episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number };
}

export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  monitored: boolean;
  hasFile: boolean;
  episodeFileId?: number;
}

export class SonarrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  ping() {
    return arrFetch<{ version: string }>(this.baseUrl, this.apiKey, "/api/v3/system/status");
  }

  getSeries() {
    return arrFetch<SonarrSeries[]>(this.baseUrl, this.apiKey, "/api/v3/series");
  }

  getEpisodes(seriesId: number) {
    return arrFetch<SonarrEpisode[]>(
      this.baseUrl,
      this.apiKey,
      `/api/v3/episode?seriesId=${seriesId}&includeEpisodeFile=false`
    );
  }

  /** Bulk toggle episode monitoring. */
  setEpisodeMonitored(episodeIds: number[], monitored: boolean) {
    if (!episodeIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/episode/monitor", {
      method: "PUT",
      body: JSON.stringify({ episodeIds, monitored }),
    });
  }

  /** Delete a single episode file. */
  deleteEpisodeFile(episodeFileId: number) {
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/episodefile/${episodeFileId}`, {
      method: "DELETE",
    });
  }

  /** Kick off a search for the given episode ids. */
  searchEpisodes(episodeIds: number[]) {
    if (!episodeIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "EpisodeSearch", episodeIds }),
    });
  }
}

/* ------------------------------- Radarr -------------------------------- */

export interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  monitored: boolean;
  hasFile: boolean;
  tmdbId?: number;
  imdbId?: string;
  movieFile?: { id: number };
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
}

export class RadarrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  ping() {
    return arrFetch<{ version: string }>(this.baseUrl, this.apiKey, "/api/v3/system/status");
  }

  getMovies() {
    return arrFetch<RadarrMovie[]>(this.baseUrl, this.apiKey, "/api/v3/movie");
  }

  getMovie(id: number) {
    return arrFetch<RadarrMovie>(this.baseUrl, this.apiKey, `/api/v3/movie/${id}`);
  }

  /** Toggle monitoring by PUTting the full movie resource back. */
  async setMovieMonitored(id: number, monitored: boolean) {
    const movie = await this.getMovie(id);
    movie.monitored = monitored;
    return arrFetch<RadarrMovie>(this.baseUrl, this.apiKey, `/api/v3/movie/${id}`, {
      method: "PUT",
      body: JSON.stringify(movie),
    });
  }

  deleteMovieFile(movieFileId: number) {
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/moviefile/${movieFileId}`, {
      method: "DELETE",
    });
  }

  searchMovies(movieIds: number[]) {
    if (!movieIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "MoviesSearch", movieIds }),
    });
  }
}

export function posterFromImages(
  images?: { coverType: string; remoteUrl?: string; url?: string }[]
): string | null {
  if (!images) return null;
  const poster = images.find((i) => i.coverType === "poster");
  return poster?.remoteUrl || poster?.url || null;
}

/* -------------------------------- Seerr -------------------------------- */

export interface SeerrArrInstance {
  id: number;
  name: string;
  hostname: string;
  port: number;
  apiKey: string;
  useSsl?: boolean;
  baseUrl?: string;
}

/**
 * Discover Sonarr/Radarr instances configured inside Seerr.
 * Seerr exposes them at /api/v1/settings/{sonarr,radarr}.
 */
export class SeerrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private base() {
    return normalizeBase(this.baseUrl);
  }

  private buildUrl(inst: SeerrArrInstance): string {
    const proto = inst.useSsl ? "https" : "http";
    const path = inst.baseUrl ? `/${inst.baseUrl.replace(/^\/+/, "")}` : "";
    return `${proto}://${inst.hostname}:${inst.port}${path}`;
  }

  async getSonarr(): Promise<{ name: string; baseUrl: string; apiKey: string }[]> {
    const data = await arrFetch<SeerrArrInstance[]>(
      this.base(),
      this.apiKey,
      "/api/v1/settings/sonarr"
    );
    return data.map((i) => ({ name: i.name, baseUrl: this.buildUrl(i), apiKey: i.apiKey }));
  }

  async getRadarr(): Promise<{ name: string; baseUrl: string; apiKey: string }[]> {
    const data = await arrFetch<SeerrArrInstance[]>(
      this.base(),
      this.apiKey,
      "/api/v1/settings/radarr"
    );
    return data.map((i) => ({ name: i.name, baseUrl: this.buildUrl(i), apiKey: i.apiKey }));
  }
}
