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
  airDateUtc: AIRED,
  ...over,
});

/** Just the season numbers a plan covers, which is what most cases care about. */
const seasons = (eps: SeasonEpisode[]) => planSeasons(eps, NOW).map((p) => p.seasonNumber);

describe("planSeasons — when a season may be marked unmonitored", () => {
  it("unmonitors a season whose every aired episode is unmonitored", () => {
    expect(seasons([ep(), ep(), ep()])).toEqual([1]);
  });

  it("leaves a season alone while any aired episode is still monitored", () => {
    expect(seasons([ep(), ep({ monitored: true }), ep()])).toEqual([]);
  });

  it("ignores unaired episodes, so a currently-airing season still qualifies", () => {
    // The case the whole feature turns on: the aired half is on streaming and
    // unmonitored, the unaired half is monitored so Sonarr keeps grabbing it.
    expect(seasons([ep(), ep(), ep({ monitored: true, airDateUtc: UNAIRED })])).toEqual([1]);
  });

  it("requires at least one aired episode, so a future season is never touched", () => {
    expect(seasons([ep({ airDateUtc: UNAIRED }), ep({ airDateUtc: UNAIRED })])).toEqual([]);
  });

  it("treats an episode with no announced date as not yet aired", () => {
    expect(seasons([ep({ airDateUtc: null }), ep({ airDateUtc: null })])).toEqual([]);
    expect(seasons([ep(), ep({ monitored: true, airDateUtc: null })])).toEqual([1]);
  });

  it("counts an episode airing exactly now as aired", () => {
    expect(seasons([ep({ airDateUtc: NOW })])).toEqual([1]);
    expect(seasons([ep({ monitored: true, airDateUtc: NOW })])).toEqual([]);
  });

  it("never considers season 0, whose specials sync does not record", () => {
    // Every episode we hold for season 0 is unmonitored because we hold none.
    expect(seasons([ep({ seasonNumber: 0 }), ep({ seasonNumber: 2 })])).toEqual([2]);
  });

  it("judges each season on its own episodes, in season order", () => {
    expect(
      seasons([
        ep({ seasonNumber: 3 }),
        ep({ seasonNumber: 1 }),
        ep({ seasonNumber: 2, monitored: true }),
      ])
    ).toEqual([1, 3]);
  });

  it("returns nothing for a series with no episodes", () => {
    expect(planSeasons([], NOW)).toEqual([]);
  });
});

describe("planSeasons — episodes the season change must not clear", () => {
  it("lists the monitored unaired episodes Sonarr's cascade would unmonitor", () => {
    const future = ep({ monitored: true, airDateUtc: UNAIRED });
    expect(planSeasons([ep(), future], NOW)).toEqual([
      { seasonNumber: 1, restore: [future.arrEpisodeId] },
    ]);
  });

  it("restores nothing when every episode of the season has aired", () => {
    expect(planSeasons([ep(), ep()], NOW)).toEqual([{ seasonNumber: 1, restore: [] }]);
  });

  it("does not restore an unaired episode that is already unmonitored", () => {
    // It is unmonitored either way, so the cascade costs it nothing.
    expect(planSeasons([ep(), ep({ monitored: false, airDateUtc: UNAIRED })], NOW)).toEqual([
      { seasonNumber: 1, restore: [] },
    ]);
  });

  it("keeps each season's restores to that season", () => {
    const s1 = ep({ seasonNumber: 1, monitored: true, airDateUtc: UNAIRED });
    const s2 = ep({ seasonNumber: 2, monitored: true, airDateUtc: UNAIRED });
    expect(planSeasons([ep({ seasonNumber: 1 }), s1, ep({ seasonNumber: 2 }), s2], NOW)).toEqual([
      { seasonNumber: 1, restore: [s1.arrEpisodeId] },
      { seasonNumber: 2, restore: [s2.arrEpisodeId] },
    ]);
  });
});
