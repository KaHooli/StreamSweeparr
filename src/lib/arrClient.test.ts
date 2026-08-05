import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The *arr clients are thin, but "thin" is where the damage lives: the sweep
 * deletes files through them. These tests pin the wire format — method, path,
 * body — because a silently wrong request either does nothing or does something
 * to the wrong title.
 */

interface Captured {
  url: string;
  init: RequestInit;
}

const calls: Captured[] = [];
let respond: (url: string, init: RequestInit) => Response;

vi.mock("./safeFetch", () => ({
  safeFetch: async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  },
}));

import {
  SonarrClient,
  RadarrClient,
  SeerrClient,
  ArrError,
  posterFromImages,
} from "./arr";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  respond = () => json([]);
});

/** The single request made, failing loudly if there wasn't exactly one. */
function only(): Captured {
  expect(calls).toHaveLength(1);
  return calls[0];
}

const body = (c: Captured) => JSON.parse(String(c.init.body));

describe("arrFetch plumbing", () => {
  it("sends the API key and JSON headers", async () => {
    await new SonarrClient("http://sonarr:8989", "abc123").getSeries();
    const headers = only().init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("abc123");
    expect(headers.Accept).toBe("application/json");
  });

  it("strips trailing slashes from the base URL", async () => {
    await new SonarrClient("http://sonarr:8989///", "k").getSeries();
    expect(only().url).toBe("http://sonarr:8989/api/v3/series");
  });

  it("reports an authentication failure distinctly", async () => {
    respond = () => json({ error: "nope" }, 401);
    await expect(new RadarrClient("http://radarr:7878", "bad").getMovies()).rejects.toMatchObject({
      name: "ArrError",
      status: 401,
    });
  });

  it("surfaces the response body on other failures", async () => {
    respond = () => new Response("upstream exploded", { status: 500 });
    const err = await new RadarrClient("http://radarr:7878", "k")
      .getMovies()
      .catch((e) => e as ArrError);
    expect(err).toBeInstanceOf(ArrError);
    expect((err as ArrError).status).toBe(500);
    expect((err as ArrError).message).toContain("upstream exploded");
  });

  it("treats 204 as an empty success", async () => {
    respond = () => new Response(null, { status: 204 });
    await expect(
      new SonarrClient("http://sonarr:8989", "k").deleteEpisodeFile(5)
    ).resolves.toBeUndefined();
  });
});

describe("SonarrClient", () => {
  const client = () => new SonarrClient("http://sonarr:8989", "k");

  it("requests episodes for one series without the file payload", async () => {
    await client().getEpisodes(42);
    expect(only().url).toBe("http://sonarr:8989/api/v3/episode?seriesId=42&includeEpisodeFile=false");
  });

  it("toggles monitoring in bulk", async () => {
    await client().setEpisodeMonitored([1, 2, 3], false);
    const c = only();
    expect(c.init.method).toBe("PUT");
    expect(c.url).toBe("http://sonarr:8989/api/v3/episode/monitor");
    expect(body(c)).toEqual({ episodeIds: [1, 2, 3], monitored: false });
  });

  it("deletes episode files in one bulk request", async () => {
    await client().deleteEpisodeFiles([7, 8, 9]);
    const c = only();
    expect(c.init.method).toBe("DELETE");
    expect(c.url).toBe("http://sonarr:8989/api/v3/episodefile/bulk");
    expect(body(c)).toEqual({ episodeFileIds: [7, 8, 9] });
  });

  it("issues an episode search command", async () => {
    await client().searchEpisodes([4, 5]);
    const c = only();
    expect(c.init.method).toBe("POST");
    expect(body(c)).toEqual({ name: "EpisodeSearch", episodeIds: [4, 5] });
  });

  it("makes no request for an empty id list", async () => {
    await client().setEpisodeMonitored([], true);
    await client().deleteEpisodeFiles([]);
    await client().searchEpisodes([]);
    expect(calls).toHaveLength(0);
  });
});

describe("RadarrClient", () => {
  const client = () => new RadarrClient("http://radarr:7878", "k");

  it("toggles monitoring through the editor endpoint, not per movie", async () => {
    await client().setMoviesMonitored([11, 12], false);
    const c = only();
    expect(c.init.method).toBe("PUT");
    expect(c.url).toBe("http://radarr:7878/api/v3/movie/editor");
    expect(body(c)).toEqual({ movieIds: [11, 12], monitored: false });
  });

  it("deletes movie files in one bulk request", async () => {
    await client().deleteMovieFiles([21, 22]);
    const c = only();
    expect(c.init.method).toBe("DELETE");
    expect(c.url).toBe("http://radarr:7878/api/v3/moviefile/bulk");
    expect(body(c)).toEqual({ movieFileIds: [21, 22] });
  });

  it("keeps files and adds no exclusion when removing a movie by default", async () => {
    await client().deleteMovie(33);
    const c = only();
    expect(c.init.method).toBe("DELETE");
    expect(c.url).toContain("deleteFiles=false");
    expect(c.url).toContain("addImportExclusion=false");
  });

  it("passes through explicit removal options", async () => {
    await client().deleteMovie(33, { deleteFiles: true, addImportExclusion: true });
    expect(only().url).toContain("deleteFiles=true&addImportExclusion=true");
  });

  it("round-trips the full resource for a single-movie monitor change", async () => {
    respond = (url, init) =>
      init.method === "PUT" ? json({}) : json({ id: 33, title: "X", monitored: true });
    await client().setMovieMonitored(33, false);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.method).toBeUndefined(); // the GET
    expect(calls[1].init.method).toBe("PUT");
    expect(body(calls[1]).monitored).toBe(false);
  });

  it("makes no request for an empty id list", async () => {
    await client().setMoviesMonitored([], true);
    await client().deleteMovieFiles([]);
    await client().searchMovies([]);
    expect(calls).toHaveLength(0);
  });
});

describe("SeerrClient", () => {
  it("builds instance URLs from host, port, scheme and base path", async () => {
    respond = () =>
      json([
        { id: 1, name: "Main", hostname: "sonarr.lan", port: 8989, apiKey: "s1" },
        {
          id: 2,
          name: "Secure",
          hostname: "sonarr2.lan",
          port: 443,
          apiKey: "s2",
          useSsl: true,
          baseUrl: "/sonarr",
        },
      ]);
    const found = await new SeerrClient("http://seerr:5055/", "k").getSonarr();
    expect(found).toEqual([
      { name: "Main", baseUrl: "http://sonarr.lan:8989", apiKey: "s1" },
      { name: "Secure", baseUrl: "https://sonarr2.lan:443/sonarr", apiKey: "s2" },
    ]);
    expect(only().url).toBe("http://seerr:5055/api/v1/settings/sonarr");
  });
});

describe("posterFromImages", () => {
  it("prefers the remote URL of the poster", () => {
    expect(
      posterFromImages([
        { coverType: "banner", remoteUrl: "http://b" },
        { coverType: "poster", remoteUrl: "http://p", url: "/local" },
      ])
    ).toBe("http://p");
  });

  it("falls back to the local URL, then to null", () => {
    expect(posterFromImages([{ coverType: "poster", url: "/local" }])).toBe("/local");
    expect(posterFromImages([{ coverType: "fanart", url: "/f" }])).toBeNull();
    expect(posterFromImages(undefined)).toBeNull();
  });
});
