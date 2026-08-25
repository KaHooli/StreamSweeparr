import { describe, it, expect } from "vitest";
import {
  planItem,
  planQueueRemovals,
  planSeasons,
  planSeriesMonitored,
  planEpisodeSearch,
  type ItemPlan,
  type QueueCandidate,
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
const CANCEL = { deleteFiles: false, purgeUnmonitoredFiles: false, cancelQueuedDownloads: true };

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
    expect(plan).toEqual({ monitor: "unmonitor", deleteFile: "on streaming", cancelDownload: null });
  });

  it("does not touch files of already-unmonitored items", () => {
    // This is the gap purgeUnmonitoredFiles exists to close.
    const plan = planItem(item({ monitored: false, onStreaming: true }), DELETE_ONLY);
    expect(plan).toEqual({ monitor: "none", deleteFile: null, cancelDownload: null });
  });

  it("deletes nothing when disabled", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), OFF);
    expect(plan).toEqual({ monitor: "unmonitor", deleteFile: null, cancelDownload: null });
  });
});

describe("planItem — purgeUnmonitoredFiles", () => {
  it("purges an already-unmonitored item that is on streaming", () => {
    const plan = planItem(item({ monitored: false, onStreaming: true }), PURGE_ONLY);
    expect(plan).toEqual({ monitor: "none", deleteFile: "unmonitored", cancelDownload: null });
  });

  it("purges an unmonitored item whose streaming status is unknown", () => {
    // It stays unmonitored, so its file is in scope.
    const plan = planItem(item({ monitored: false, streamingUnknown: true }), PURGE_ONLY);
    expect(plan).toEqual({ monitor: "none", deleteFile: "unmonitored", cancelDownload: null });
  });

  it("purges an item this sweep unmonitored even when deleteFiles is off", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), PURGE_ONLY);
    expect(plan).toEqual({ monitor: "unmonitor", deleteFile: "unmonitored", cancelDownload: null });
  });

  it("never purges an item being re-monitored", () => {
    // It ends the sweep monitored, so the file must survive for playback.
    const plan = planItem(item({ monitored: false, onStreaming: false }), BOTH);
    expect(plan).toEqual({ monitor: "remonitor", deleteFile: null, cancelDownload: null });
  });

  it("never purges a monitored item", () => {
    const plan = planItem(item({ monitored: true, onStreaming: false }), BOTH);
    expect(plan).toEqual({ monitor: "none", deleteFile: null, cancelDownload: null });
  });

  it("reports a single reason so a file is never queued twice", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true }), BOTH);
    expect(plan.deleteFile).toBe("on streaming");
  });

  it("does nothing for items with no file", () => {
    for (const settings of [OFF, DELETE_ONLY, PURGE_ONLY, BOTH]) {
      expect(planItem(item({ monitored: false, onStreaming: true, hasFile: false }), settings))
        .toEqual({ monitor: "none", deleteFile: null, cancelDownload: null });
    }
  });

  it("leaves pre-existing behaviour untouched while switched off", () => {
    // Regression guard: with purgeUnmonitoredFiles off, the only file deleted is
    // still the one belonging to a title this sweep just unmonitored.
    const expected: [ReturnType<typeof item>, ItemPlan][] = [
      [item({ monitored: true, onStreaming: true }), { monitor: "unmonitor", deleteFile: "on streaming", cancelDownload: null }],
      [item({ monitored: false, onStreaming: true }), { monitor: "none", deleteFile: null, cancelDownload: null }],
      [item({ monitored: false, onStreaming: false }), { monitor: "remonitor", deleteFile: null, cancelDownload: null }],
      [item({ monitored: true, onStreaming: false }), { monitor: "none", deleteFile: null, cancelDownload: null }],
      [item({ monitored: false, streamingUnknown: true }), { monitor: "none", deleteFile: null, cancelDownload: null }],
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

/** An episode, defaulting to "aired, answered for, unmonitored once the sweep lands". */
const ep = (over: Partial<SeasonEpisode> = {}): SeasonEpisode => ({
  seasonNumber: 1,
  arrEpisodeId: nextEpisodeId++,
  monitored: false,
  streamingUnknown: false,
  airDateUtc: AIRED,
  ...over,
});

/** An episode left monitored once the sweep lands. */
const onEp = (over: Partial<SeasonEpisode> = {}): SeasonEpisode =>
  ep({ monitored: true, ...over });

/**
 * The shape this whole rule turns on: aired and monitored, but the provider
 * never returned a record for it — Watchmode's collapsed multi-part finale.
 */
const unknownEp = (over: Partial<SeasonEpisode> = {}): SeasonEpisode =>
  ep({ monitored: true, streamingUnknown: true, ...over });

/** Season number -> flag written, which is what most cases care about. */
const flags = (eps: SeasonEpisode[]) =>
  planSeasons(eps, NOW).map((p) => [p.seasonNumber, p.monitored]);

describe("planItem — cancelQueuedDownloads", () => {
  it("cancels the download of an item it just unmonitored", () => {
    const plan = planItem(
      item({ monitored: true, onStreaming: true, inQueue: true, hasFile: false }),
      CANCEL
    );
    expect(plan).toEqual({
      monitor: "unmonitor",
      deleteFile: null,
      cancelDownload: "on streaming",
    });
  });

  it("cancels regardless of whether the title also has a file already", () => {
    // A download in flight and a file on disk are independent: a title being
    // upgraded has both, and unmonitoring it should stop the incoming copy.
    const plan = planItem(
      item({ monitored: true, onStreaming: true, inQueue: true, hasFile: true }),
      { ...CANCEL, deleteFiles: true }
    );
    expect(plan).toEqual({
      monitor: "unmonitor",
      deleteFile: "on streaming",
      cancelDownload: "on streaming",
    });
  });

  it("does nothing for an item that is not downloading", () => {
    const plan = planItem(item({ monitored: true, onStreaming: true, inQueue: false }), CANCEL);
    expect(plan.cancelDownload).toBeNull();
  });

  it("leaves the already-unmonitored back-catalogue alone on its own", () => {
    // Without the purge switch this stays as narrow as `deleteFiles` is.
    const plan = planItem(item({ monitored: false, onStreaming: true, inQueue: true }), CANCEL);
    expect(plan.cancelDownload).toBeNull();
  });

  it("never cancels for an item it is re-monitoring", () => {
    const plan = planItem(
      item({ monitored: false, onStreaming: false, inQueue: true }),
      CANCEL
    );
    expect(plan).toEqual({ monitor: "remonitor", deleteFile: null, cancelDownload: null });
  });

  it("never cancels on an unknown streaming answer for a monitored item", () => {
    const plan = planItem(
      item({ monitored: true, streamingUnknown: true, inQueue: true }),
      CANCEL
    );
    expect(plan.cancelDownload).toBeNull();
  });

  it("cancels nothing while the setting is off", () => {
    for (const settings of [OFF, DELETE_ONLY, PURGE_ONLY, BOTH]) {
      const plan = planItem(item({ monitored: true, onStreaming: true, inQueue: true }), settings);
      expect(plan.cancelDownload).toBeNull();
    }
  });
});

describe("planItem — cancelQueuedDownloads alongside purgeUnmonitoredFiles", () => {
  const CANCEL_PURGE = { ...CANCEL, purgeUnmonitoredFiles: true };

  it("cancels the download of an already-unmonitored item", () => {
    // The pairing that makes a library-wide clear-out stick: purging files
    // while the download client keeps filling the library back up is no purge.
    const plan = planItem(
      item({ monitored: false, onStreaming: true, inQueue: true, hasFile: false }),
      CANCEL_PURGE
    );
    expect(plan).toEqual({
      monitor: "none",
      deleteFile: null,
      cancelDownload: "unmonitored",
    });
  });

  it("cancels an unmonitored item that has no file yet", () => {
    // The case the file rules structurally cannot reach: a part-finished
    // download has produced nothing on disk, so `deleteFile` has nothing to
    // act on while the download is exactly what should be stopped.
    const plan = planItem(
      item({ monitored: false, onStreaming: false, streamingUnknown: true, inQueue: true, hasFile: false }),
      CANCEL_PURGE
    );
    expect(plan.deleteFile).toBeNull();
    expect(plan.cancelDownload).toBe("unmonitored");
  });

  it("reports the download and the file separately for an unmonitored item with both", () => {
    const plan = planItem(
      item({ monitored: false, onStreaming: true, inQueue: true, hasFile: true }),
      CANCEL_PURGE
    );
    expect(plan).toEqual({
      monitor: "none",
      deleteFile: "unmonitored",
      cancelDownload: "unmonitored",
    });
  });

  it("still calls this sweep's own unmonitors 'on streaming'", () => {
    // Both reasons apply to a title the sweep just unmonitored; the specific
    // one wins, so the run log says why the title was actually caught.
    const plan = planItem(
      item({ monitored: true, onStreaming: true, inQueue: true, hasFile: false }),
      CANCEL_PURGE
    );
    expect(plan.cancelDownload).toBe("on streaming");
  });

  it("never cancels an item that ends the sweep monitored", () => {
    // Re-monitored, and the plain monitored title that is simply downloading.
    const remonitored = planItem(
      item({ monitored: false, onStreaming: false, inQueue: true }),
      CANCEL_PURGE
    );
    expect(remonitored.cancelDownload).toBeNull();

    const wanted = planItem(
      item({ monitored: true, onStreaming: false, inQueue: true }),
      CANCEL_PURGE
    );
    expect(wanted.cancelDownload).toBeNull();
  });

  it("cancels nothing for an unmonitored item that is not downloading", () => {
    const plan = planItem(item({ monitored: false, onStreaming: true }), CANCEL_PURGE);
    expect(plan.cancelDownload).toBeNull();
  });

  it("purges files without cancelling while the cancel switch is off", () => {
    const plan = planItem(
      item({ monitored: false, onStreaming: true, inQueue: true }),
      PURGE_ONLY
    );
    expect(plan).toEqual({ monitor: "none", deleteFile: "unmonitored", cancelDownload: null });
  });
});

/** A queue row, defaulting to "its own download, still coming in". */
const row = (over: Partial<QueueCandidate> = {}): QueueCandidate => ({
  queueId: 1,
  itemId: 100,
  downloadId: null,
  cancellable: true,
  ...over,
});

describe("planQueueRemovals", () => {
  it("cancels a download whose only item is being unmonitored", () => {
    const out = planQueueRemovals([row({ queueId: 7, itemId: 100 })], new Set([100]));
    expect(out).toEqual([{ queueIds: [7], itemIds: [100] }]);
  });

  it("ignores a download for an item the sweep is not unmonitoring", () => {
    expect(planQueueRemovals([row({ itemId: 100 })], new Set([999]))).toEqual([]);
  });

  it("cancels a shared download only when every episode on it is unmonitored", () => {
    // The season-pack rule: one torrent, one queue row per episode.
    const pack = [
      row({ queueId: 1, itemId: 100, downloadId: "abc" }),
      row({ queueId: 2, itemId: 101, downloadId: "abc" }),
      row({ queueId: 3, itemId: 102, downloadId: "abc" }),
    ];
    expect(planQueueRemovals(pack, new Set([100, 101, 102]))).toEqual([
      { queueIds: [1, 2, 3], itemIds: [100, 101, 102] },
    ]);
  });

  it("spares a season pack holding one episode the user still wants", () => {
    // Cancelling would take the wanted episode with it — the whole reason the
    // decision is made per download rather than per row.
    const pack = [
      row({ queueId: 1, itemId: 100, downloadId: "abc" }),
      row({ queueId: 2, itemId: 101, downloadId: "abc" }),
    ];
    expect(planQueueRemovals(pack, new Set([100]))).toEqual([]);
  });

  it("keeps separate downloads separate", () => {
    const rows = [
      row({ queueId: 1, itemId: 100, downloadId: "abc" }),
      row({ queueId: 2, itemId: 101, downloadId: "def" }),
    ];
    expect(planQueueRemovals(rows, new Set([100]))).toEqual([
      { queueIds: [1], itemIds: [100] },
    ]);
  });

  it("treats rows with no download id as downloads of their own", () => {
    const rows = [
      row({ queueId: 1, itemId: 100, downloadId: null }),
      row({ queueId: 2, itemId: 101, downloadId: null }),
    ];
    expect(planQueueRemovals(rows, new Set([100, 101]))).toEqual([
      { queueIds: [1], itemIds: [100] },
      { queueIds: [2], itemIds: [101] },
    ]);
  });

  it("leaves a download that has moved on to importing", () => {
    const rows = [row({ queueId: 1, itemId: 100, cancellable: false })];
    expect(planQueueRemovals(rows, new Set([100]))).toEqual([]);
  });

  it("spares the whole download when one of its rows is already importing", () => {
    const pack = [
      row({ queueId: 1, itemId: 100, downloadId: "abc" }),
      row({ queueId: 2, itemId: 101, downloadId: "abc", cancellable: false }),
    ];
    expect(planQueueRemovals(pack, new Set([100, 101]))).toEqual([]);
  });

  it("never matches a row *arr could not attribute to a title", () => {
    expect(planQueueRemovals([row({ itemId: null })], new Set([100]))).toEqual([]);
  });

  it("lets an unattributable row protect the download it shares", () => {
    const pack = [
      row({ queueId: 1, itemId: 100, downloadId: "abc" }),
      row({ queueId: 2, itemId: null, downloadId: "abc" }),
    ];
    expect(planQueueRemovals(pack, new Set([100]))).toEqual([]);
  });

  it("does nothing with an empty queue", () => {
    expect(planQueueRemovals([], new Set([100]))).toEqual([]);
  });
});

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

describe("planSeasons — episodes the provider never answered for", () => {
  it("ignores an unknown episode rather than letting it deny the season", () => {
    // The bug this closes: Watchmode collapses a two-part finale into one
    // record, so Sonarr's E24 matched nothing and was stored as "not on
    // streaming" — a confident negative that denied the whole season.
    expect(flags([ep(), ep(), unknownEp()])).toEqual([[1, false]]);
  });

  it("still needs one aired episode it did get an answer for", () => {
    // A season the provider said nothing about at all is not spent, it is
    // unheard of. Marking it on that silence is the failure mode to avoid.
    expect(flags([unknownEp(), unknownEp()])).toEqual([[1, true]]);
  });

  it("does not let an unknown episode stand in for evidence", () => {
    // Only the unknown one is monitored, and it cannot speak — but neither can
    // it be ignored into a season with no aired, answered episodes at all.
    expect(flags([ep({ airDateUtc: UNAIRED }), unknownEp()])).toEqual([[1, true]]);
  });

  it("still refuses when an aired, answered episode is monitored", () => {
    expect(flags([ep(), onEp(), unknownEp()])).toEqual([[1, true]]);
  });

  it("puts the unknown episode back after the season write", () => {
    // It is monitored on purpose; the cascade would clear it like any other.
    const finale = unknownEp();
    expect(planSeasons([ep(), ep(), finale], NOW)).toEqual([
      { seasonNumber: 1, monitored: false, correct: [finale.arrEpisodeId] },
    ]);
  });

  it("treats an unknown, unmonitored episode as no obstacle", () => {
    expect(planSeasons([ep(), ep({ streamingUnknown: true })], NOW)).toEqual([
      { seasonNumber: 1, monitored: false, correct: [] },
    ]);
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
