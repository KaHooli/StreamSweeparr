import { describe, it, expect } from "vitest";
import { planItem, planSeasons, type ItemPlan, type SeasonEpisode } from "./sweep";

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
  remonitored: false,
  airDateUtc: AIRED,
  ...over,
});

/** An episode this sweep re-monitored, which is what asks for a season back on. */
const reEp = (over: Partial<SeasonEpisode> = {}): SeasonEpisode =>
  ep({ monitored: true, remonitored: true, ...over });

/** Season number -> flag written, which is what most cases care about. */
const flags = (eps: SeasonEpisode[]) =>
  planSeasons(eps, NOW).map((p) => [p.seasonNumber, p.monitored]);

describe("planSeasons — turning a season off", () => {
  it("unmonitors a season whose every aired episode is unmonitored", () => {
    expect(flags([ep(), ep(), ep()])).toEqual([[1, false]]);
  });

  it("leaves a season alone while any aired episode is still monitored", () => {
    expect(flags([ep(), ep({ monitored: true }), ep()])).toEqual([]);
  });

  it("ignores unaired episodes, so a currently-airing season still qualifies", () => {
    // The case the feature turns on: the aired half is on streaming and
    // unmonitored, the unaired half is monitored so Sonarr keeps grabbing it.
    expect(flags([ep(), ep(), ep({ monitored: true, airDateUtc: UNAIRED })])).toEqual([[1, false]]);
  });

  it("requires at least one aired episode, so a future season is never touched", () => {
    expect(flags([ep({ airDateUtc: UNAIRED }), ep({ airDateUtc: UNAIRED })])).toEqual([]);
  });

  it("treats an episode with no announced date as not yet aired", () => {
    expect(flags([ep({ airDateUtc: null }), ep({ airDateUtc: null })])).toEqual([]);
    expect(flags([ep(), ep({ monitored: true, airDateUtc: null })])).toEqual([[1, false]]);
  });

  it("counts an episode airing exactly now as aired", () => {
    expect(flags([ep({ airDateUtc: NOW })])).toEqual([[1, false]]);
    expect(flags([ep({ monitored: true, airDateUtc: NOW })])).toEqual([]);
  });

  it("never considers season 0, whose specials sync does not record", () => {
    // Every episode we hold for season 0 is unmonitored because we hold none.
    expect(flags([ep({ seasonNumber: 0 }), ep({ seasonNumber: 2 })])).toEqual([[2, false]]);
  });

  it("returns nothing for a series with no episodes", () => {
    expect(planSeasons([], NOW)).toEqual([]);
  });
});

describe("planSeasons — turning a season back on", () => {
  it("monitors a season this sweep re-monitored an episode in", () => {
    expect(flags([reEp(), ep({ monitored: true })])).toEqual([[1, true]]);
  });

  it("does not monitor a season merely because an episode is monitored", () => {
    // The user unmonitored this season by hand and nothing changed this run;
    // overriding that every sweep is the behaviour being avoided.
    expect(flags([ep({ monitored: true }), ep({ monitored: true })])).toEqual([]);
  });

  it("monitors a season where only some episodes came back", () => {
    // The rest are still on streaming, and stay unmonitored.
    expect(flags([reEp(), ep(), ep()])).toEqual([[1, true]]);
  });

  it("prefers off when a spent season also has an unaired episode re-monitored", () => {
    // planItem re-monitors an unaired episode for want of availability data.
    // Letting that turn the season back on would flip the flag every sweep,
    // and the episode is grabbed on its own flag regardless.
    expect(flags([ep(), ep(), reEp({ airDateUtc: UNAIRED })])).toEqual([[1, false]]);
  });

  it("judges each season on its own episodes, in season order", () => {
    expect(
      flags([
        ep({ seasonNumber: 3 }),
        reEp({ seasonNumber: 1 }),
        ep({ seasonNumber: 2, monitored: true }),
      ])
    ).toEqual([
      [1, true],
      [3, false],
    ]);
  });
});

describe("planSeasons — episodes the season write must not flatten", () => {
  it("lists the monitored unaired episodes an off-write would clear", () => {
    const future = ep({ monitored: true, airDateUtc: UNAIRED });
    expect(planSeasons([ep(), future], NOW)).toEqual([
      { seasonNumber: 1, monitored: false, correct: [future.arrEpisodeId] },
    ]);
  });

  it("lists the on-streaming episodes an on-write would monitor", () => {
    // The whole point of the sweep: these must not come back monitored.
    const streaming = ep();
    expect(planSeasons([reEp(), streaming], NOW)).toEqual([
      { seasonNumber: 1, monitored: true, correct: [streaming.arrEpisodeId] },
    ]);
  });

  it("corrects nothing when every episode already agrees with the season", () => {
    expect(planSeasons([ep(), ep()], NOW)).toEqual([
      { seasonNumber: 1, monitored: false, correct: [] },
    ]);
    expect(planSeasons([reEp(), reEp()], NOW)).toEqual([
      { seasonNumber: 1, monitored: true, correct: [] },
    ]);
  });

  it("keeps each season's corrections to that season", () => {
    const future = ep({ seasonNumber: 1, monitored: true, airDateUtc: UNAIRED });
    const streaming = ep({ seasonNumber: 2 });
    expect(
      planSeasons([ep({ seasonNumber: 1 }), future, reEp({ seasonNumber: 2 }), streaming], NOW)
    ).toEqual([
      { seasonNumber: 1, monitored: false, correct: [future.arrEpisodeId] },
      { seasonNumber: 2, monitored: true, correct: [streaming.arrEpisodeId] },
    ]);
  });
});
