import { describe, it, expect } from "vitest";
import { planItem, type ItemPlan } from "./sweep";

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
