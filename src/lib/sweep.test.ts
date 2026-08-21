import { describe, it, expect } from "vitest";
import {
  planItem,
  planSeasons,
  planEpisodeSearch,
  type ItemPlan,
  type SeasonEpisode,
  type SearchEpisode,
} from "./sweep";

/** Build an item, defaulting to "monitored, not on streaming, has a file". */
const item = (over: Partial<Parameters<typeof planItem>[0]> = {}) => ({
  monitored: true,
  onStreaming: false,
  streamingUnknown: false,
  hasFile: true,
  ...over,
});

const OFF = { deleteFiles: false, purgeUnmonitoredFiles: false };
const DELETE_ONLY = { deleteFiles: true, purgeUnmonitoredFiles: false };
const PURGE_ONLY = { deleteFiles: false, purgeUnmonitoredFiles: true };
const BOTH = { deleteFiles: true, purgeUnmonitoredFiles: true };

describe("planItem — monitoring decisions", () => {
  it("unmonitors a monitored item that is on streaming", () => {
    expect(planItem(item({ monitored: true, onStreaming: true }), OFF).monitor).toBe("unmonitor");
  });

  it("re-monitors an unmonitored item that is confidently off streaming", () => {
    expect(planItem(item({ monitored: false, onStreaming: false }), OFF).monitor).toBe("remonitor");
  });

  it("leaves an item alone when streaming status is unknown", () => {
    const plan = planItem(item({ monitored: false, streamingUnknown: true }), OFF);
    expect(plan.monitor).toBe("none");
  });

  it("leaves a monitored item that is not on streaming alone", () => {
    expect(planItem(item({ monitored: true, onStreaming: false }), OFF).monitor).toBe("none");
  });
});

describe("planItem — deleteFiles (only what this sweep unmonitors)", () => {
  it("deletes the file of an item it just unmonitored", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), DELETE_ONLY);
    expect(plan).toEqual({ monitor: "unmonitor", deleteFile: "on streaming" });
  });

  it("does not touch files of already-unmonitored items", () => {
    // This is the gap purgeUnmonitoredFiles exists to close.
    const plan = planItem(item({ monitored: false, onStreaming: true }), DELETE_ONLY);
    expect(plan).toEqual({ monitor: "none", deleteFile: null });
  });

  it("deletes nothing when disabled", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), OFF);
    expect(plan).toEqual({ monitor: "unmonitor", deleteFile: null });
  });
});

describe("planItem — purgeUnmonitoredFiles", () => {
  it("purges an already-unmonitored item that is on streaming", () => {
    const plan = planItem(item({ monitored: false, onStreaming: true }), PURGE_ONLY);
    expect(plan).toEqual({ monitor: "none", deleteFile: "unmonitored" });
  });

  it("purges an unmonitored item whose streaming status is unknown", () => {
    // It stays unmonitored, so its file is in scope.
    const plan = planItem(item({ monitored: false, streamingUnknown: true }), PURGE_ONLY);
    expect(plan).toEqual({ monitor: "none", deleteFile: "unmonitored" });
  });

  it("purges an item this sweep unmonitored even when deleteFiles is off", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), PURGE_ONLY);
    expect(plan).toEqual({ monitor: "unmonitor", deleteFile: "unmonitored" });
  });

  it("never purges an item being re-monitored", () => {
    // It ends the sweep monitored, so the file must survive for playback.
    const plan = planItem(item({ monitored: false, onStreaming: false }), BOTH);
    expect(plan).toEqual({ monitor: "remonitor", deleteFile: null });
  });

  it("never purges a monitored item", () => {
    const plan = planItem(item({ monitored: true, onStreaming: false }), BOTH);
    expect(plan).toEqual({ monitor: "none", deleteFile: null });
  });

  it("reports a single reason so a file is never queued twice", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), BOTH);
    expect(plan.deleteFile).toBe("on streaming");
  });

  it("does nothing for items with no file", () => {
    for (const settings of [OFF, DELETE_ONLY, PURGE_ONLY, BOTH]) {
      expect(planItem(item({ monitored: false, onStreaming: true, hasFile: false }), settings))
        .toEqual({ monitor: "none", deleteFile: null });
    }
  });

  it("leaves pre-existing behaviour untouched while switched off", () => {
    // Regression guard: with purgeUnmonitoredFiles off, the only file deleted is
    // still the one belonging to a title this sweep just unmonitored.
    const expected: [ReturnType<typeof item>, ItemPlan][] = [
      [item({ monitored: true, onStreaming: true }), { monitor: "unmonitor", deleteFile: "on streaming" }],
      [item({ monitored: false, onStreaming: true }), { monitor: "none", deleteFile: null }],
      [item({ monitored: false, onStreaming: false }), { monitor: "remonitor", deleteFile: null }],
      [item({ monitored: true, onStreaming: false }), { monitor: "none", deleteFile: null }],
      [item({ monitored: false, streamingUnknown: true }), { monitor: "none", deleteFile: null }],
    ];
    for (const [input, want] of expected) {
      expect(planItem(input, DELETE_ONLY)).toEqual(want);
    }
  });
});


/* ---------------------------- planSeasons ------------------------------ */

const NOW = new Date("2026-06-15T00:00:00Z");
const AIRED = new Date("2026-01-01T00:00:00Z");
const UNAIRED = new Date("2026-12-01T00:00:00Z");

let nextEpisodeId = 1;

/** An episode, defaulting to "aired, and unmonitored once the sweep lands". */
const ep = (over: Partial<SeasonEpisode> = {}): SeasonEpisode => ({
  seasonNumber: 1,
  arrEpisodeId: nextEpisodeId++,
  monitored: false,
  airDateUtc: AIRED,
  ...over,
});

/** An episode left monitored once the sweep lands. */
const onEp = (over: Partial<SeasonEpisode> = {}): SeasonEpisode =>
  ep({ monitored: true, ...over });

/** Season number -> flag written, which is what most cases care about. */
const flags = (eps: SeasonEpisode[]) =>
  planSeasons(eps, NOW).map((p) => [p.seasonNumber, p.monitored]);

describe("planSeasons — turning a season off", () => {
  it("unmonitors a season whose every aired episode is unmonitored", () => {
    expect(flags([ep(), ep(), ep()])).toEqual([[1, false]]);
  });

  it("ignores unaired episodes, so a currently-airing season still qualifies", () => {
    // The case the feature turns on: the aired half is on streaming and
    // unmonitored, the unaired half is monitored so Sonarr keeps grabbing it.
    expect(flags([ep(), ep(), onEp({ airDateUtc: UNAIRED })])).toEqual([[1, false]]);
  });

  it("requires at least one aired episode, so a future season is never touched", () => {
    expect(flags([ep({ airDateUtc: UNAIRED }), ep({ airDateUtc: UNAIRED })])).toEqual([]);
  });

  it("treats an episode with no announced date as not yet aired", () => {
    expect(flags([ep({ airDateUtc: null }), ep({ airDateUtc: null })])).toEqual([]);
    expect(flags([ep(), onEp({ airDateUtc: null })])).toEqual([[1, false]]);
  });

  it("counts an episode airing exactly now as aired", () => {
    expect(flags([ep({ airDateUtc: NOW })])).toEqual([[1, false]]);
  });

  it("never considers season 0, whose specials sync does not record", () => {
    // Every episode we hold for season 0 is unmonitored because we hold none.
    expect(flags([ep({ seasonNumber: 0 }), ep({ seasonNumber: 2 })])).toEqual([[2, false]]);
  });

  it("returns nothing for a series with no episodes", () => {
    expect(planSeasons([], NOW)).toEqual([]);
  });
});

describe("planSeasons — turning a season on", () => {
  it("monitors a season that still holds a monitored episode", () => {
    expect(flags([onEp(), onEp()])).toEqual([[1, true]]);
  });

  it("monitors a season where only some episodes are monitored", () => {
    // The rest are still on streaming, and stay unmonitored.
    expect(flags([onEp(), ep(), ep()])).toEqual([[1, true]]);
  });

  it("monitors a season whose only monitored episode has not aired", () => {
    // Nothing has aired, so the off rule has no evidence; the monitored
    // episode is reason enough for the flag to say so.
    expect(flags([ep({ airDateUtc: UNAIRED }), onEp({ airDateUtc: UNAIRED })])).toEqual([[1, true]]);
  });

  it("does not defer to a season the user unmonitored by hand", () => {
    // ss-skip is how a title opts out; short of that the flag describes the
    // episodes, exactly as planItem already overrides hand-set episodes.
    expect(flags([onEp(), onEp()])).toEqual([[1, true]]);
  });

  it("prefers off when a spent season still has unaired episodes monitored", () => {
    // Letting the on rule win here would flip the flag every sweep, and the
    // unaired episode is grabbed on its own flag regardless.
    expect(flags([ep(), ep(), onEp({ airDateUtc: UNAIRED })])).toEqual([[1, false]]);
  });

  it("judges each season on its own episodes, in season order", () => {
    expect(
      flags([ep({ seasonNumber: 3 }), onEp({ seasonNumber: 1 }), ep({ seasonNumber: 2 })])
    ).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });
});

describe("planSeasons — episodes the season write must not flatten", () => {
  it("lists the monitored unaired episodes an off-write would clear", () => {
    const future = onEp({ airDateUtc: UNAIRED });
    expect(planSeasons([ep(), future], NOW)).toEqual([
      { seasonNumber: 1, monitored: false, correct: [future.arrEpisodeId] },
    ]);
  });

  it("lists the on-streaming episodes an on-write would monitor", () => {
    // The whole point of the sweep: these must not come back monitored.
    const streaming = ep();
    expect(planSeasons([onEp(), streaming], NOW)).toEqual([
      { seasonNumber: 1, monitored: true, correct: [streaming.arrEpisodeId] },
    ]);
  });

  it("corrects nothing when every episode already agrees with the season", () => {
    expect(planSeasons([ep(), ep()], NOW)).toEqual([
      { seasonNumber: 1, monitored: false, correct: [] },
    ]);
    expect(planSeasons([onEp(), onEp()], NOW)).toEqual([
      { seasonNumber: 1, monitored: true, correct: [] },
    ]);
  });

  it("keeps each season's corrections to that season", () => {
    const future = onEp({ seasonNumber: 1, airDateUtc: UNAIRED });
    const streaming = ep({ seasonNumber: 2 });
    expect(
      planSeasons([ep({ seasonNumber: 1 }), future, onEp({ seasonNumber: 2 }), streaming], NOW)
    ).toEqual([
      { seasonNumber: 1, monitored: false, correct: [future.arrEpisodeId] },
      { seasonNumber: 2, monitored: true, correct: [streaming.arrEpisodeId] },
    ]);
  });
});

/* -------------------------- planEpisodeSearch --------------------------- */

/** An episode the end-of-run search wants: monitored, aired, no file. */
const want = (over: Partial<SearchEpisode> = {}): SearchEpisode => ({
  arrEpisodeId: nextEpisodeId++,
  seasonNumber: 1,
  monitored: true,
  hasFile: false,
  airDateUtc: AIRED,
  ...over,
});

/** One series' worth of episodes, as the query hands them over. */
const show = (episodes: SearchEpisode[], arrId = 1) => [{ arrId, episodes }];

describe("planEpisodeSearch — what is worth searching at all", () => {
  it("skips episodes that already have a file", () => {
    // A search could only find an upgrade for these, which is not what the
    // end-of-run search is for — and on a settled library it is most of them.
    const plan = planEpisodeSearch(show([want({ hasFile: true }), want({ hasFile: true })]), NOW);
    expect(plan).toEqual({ seasons: [], episodeIds: [], total: 0 });
  });

  it("skips unaired episodes, which have nothing to find", () => {
    const plan = planEpisodeSearch(
      show([want({ airDateUtc: UNAIRED }), want({ airDateUtc: null })]),
      NOW
    );
    expect(plan.total).toBe(0);
  });

  it("skips unmonitored episodes, whatever else is true of them", () => {
    expect(planEpisodeSearch(show([want({ monitored: false })]), NOW).total).toBe(0);
  });

  it("counts an episode airing exactly now as aired", () => {
    expect(planEpisodeSearch(show([want({ airDateUtc: NOW })]), NOW).total).toBe(1);
  });

  it("returns an empty plan for a series with no episodes", () => {
    expect(planEpisodeSearch(show([]), NOW)).toEqual({ seasons: [], episodeIds: [], total: 0 });
  });
});

describe("planEpisodeSearch — grouping into season searches", () => {
  it("searches a fully monitored season as one season query", () => {
    const plan = planEpisodeSearch(show([want(), want(), want()], 7), NOW);
    expect(plan.seasons).toEqual([{ arrId: 7, seasonNumber: 1, episodes: 3 }]);
    expect(plan.episodeIds).toEqual([]);
    // The episodes covered, not the one command it took to cover them.
    expect(plan.total).toBe(3);
  });

  it("falls back to episode ids when the season holds an unmonitored episode", () => {
    // The case that makes this stricter than Sonarr's own grouping: monitoring
    // gates grabbing, not importing, so a season pack would restore the
    // unmonitored episode — which is on streaming and was deleted on purpose.
    const a = want();
    const b = want();
    const plan = planEpisodeSearch(show([a, b, want({ monitored: false, hasFile: true })]), NOW);
    expect(plan.seasons).toEqual([]);
    expect(plan.episodeIds).toEqual([a.arrEpisodeId, b.arrEpisodeId]);
    expect(plan.total).toBe(2);
  });

  it("still groups a fully monitored season where only some episodes are missing", () => {
    // Nothing here is unmonitored, so a pack can only bring back episodes the
    // user is meant to have — the ones with files are simply already met.
    const plan = planEpisodeSearch(
      show([want(), want(), want({ hasFile: true }), want({ airDateUtc: UNAIRED })]),
      NOW
    );
    expect(plan.seasons).toEqual([{ arrId: 1, seasonNumber: 1, episodes: 2 }]);
    expect(plan.episodeIds).toEqual([]);
  });

  it("searches a lone episode individually rather than as a season", () => {
    // One query either way, and the narrower one cannot pull in a pack.
    const only = want();
    const plan = planEpisodeSearch(show([only, want({ hasFile: true })]), NOW);
    expect(plan.seasons).toEqual([]);
    expect(plan.episodeIds).toEqual([only.arrEpisodeId]);
  });

  it("judges each season separately, in season order", () => {
    const mixed = want({ seasonNumber: 3 });
    const plan = planEpisodeSearch(
      show(
        [
          want({ seasonNumber: 2 }),
          want({ seasonNumber: 2 }),
          mixed,
          want({ seasonNumber: 3, monitored: false, hasFile: true }),
          want({ seasonNumber: 1 }),
          want({ seasonNumber: 1 }),
        ],
        4
      ),
      NOW
    );
    expect(plan.seasons).toEqual([
      { arrId: 4, seasonNumber: 1, episodes: 2 },
      { arrId: 4, seasonNumber: 2, episodes: 2 },
    ]);
    expect(plan.episodeIds).toEqual([mixed.arrEpisodeId]);
    expect(plan.total).toBe(5);
  });

  it("keeps each series' seasons under its own id", () => {
    const plan = planEpisodeSearch(
      [
        { arrId: 10, episodes: [want(), want()] },
        { arrId: 20, episodes: [want({ seasonNumber: 2 }), want({ seasonNumber: 2 })] },
      ],
      NOW
    );
    expect(plan.seasons).toEqual([
      { arrId: 10, seasonNumber: 1, episodes: 2 },
      { arrId: 20, seasonNumber: 2, episodes: 2 },
    ]);
  });
});
