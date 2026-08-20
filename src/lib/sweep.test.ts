import { describe, it, expect } from "vitest";
import {
  planItem,
  planSeasons,
  planSeriesMonitored,
  type ItemPlan,
  type SeasonEpisode,
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

/* ------------------------- planSeriesMonitored -------------------------- */

/** Seasons as Sonarr reports them; only the flag matters here. */
const seasons = (...monitored: boolean[]) => monitored.map((m) => ({ monitored: m }));

describe("planSeriesMonitored — turning a show off", () => {
  it("unmonitors an ended show whose every season is unmonitored", () => {
    expect(planSeriesMonitored("ended", seasons(false, false, false))).toBe(false);
  });

  it("leaves a continuing show alone, however spent its seasons are", () => {
    // Next season is exactly what the series flag is for.
    expect(planSeriesMonitored("continuing", seasons(false, false))).toBeNull();
    expect(planSeriesMonitored("upcoming", seasons(false))).toBeNull();
  });

  it("leaves a show alone when Sonarr reports no status", () => {
    expect(planSeriesMonitored(undefined, seasons(false, false))).toBeNull();
  });

  it("matches the status case-insensitively", () => {
    expect(planSeriesMonitored("Ended", seasons(false))).toBe(false);
  });

  it("keeps an ended show whose specials are still monitored", () => {
    // Season 0 is not in the snapshot, so planSeasons never speaks for it — but
    // a user monitoring specials wants specials, and unmonitoring the series
    // would stop them.
    expect(planSeriesMonitored("ended", seasons(true, false, false))).toBe(true);
  });

  it("says nothing about a series Sonarr lists no seasons for", () => {
    // Not a spent library — a series Sonarr has not finished building.
    expect(planSeriesMonitored("ended", [])).toBeNull();
    expect(planSeriesMonitored("continuing", [])).toBeNull();
  });
});

describe("planSeriesMonitored — turning a show back on", () => {
  it("monitors a show that still holds a monitored season", () => {
    expect(planSeriesMonitored("continuing", seasons(false, true))).toBe(true);
  });

  it("monitors an ended show whose seasons came back", () => {
    // The trap this direction closes: seasons turned back on when the show left
    // streaming would never be grabbed while the series flag stayed off.
    expect(planSeriesMonitored("ended", seasons(true, false))).toBe(true);
  });

  it("needs no status to turn a show on", () => {
    expect(planSeriesMonitored(undefined, seasons(true))).toBe(true);
  });
});
