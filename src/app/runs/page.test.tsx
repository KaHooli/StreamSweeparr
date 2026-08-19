// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import RunsPage from "./page";

/**
 * Aborting is the one destructive control on this page, and the guard around it
 * is the whole point: a stray click on a row that is scrolling past must not
 * stop a sweep. So what is pinned here is that the first click only asks, that
 * the request is what actually posts, and that the button is not offered where
 * it would do nothing — a finished run, or a viewer who is not an admin.
 */

interface RunRow {
  id: number;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "ABORTED";
  dryRun?: boolean;
  abortRequestedAt?: string | null;
  error?: string | null;
}

const run = (over: RunRow) => ({
  startedAt: "2026-08-10T12:00:00.000Z",
  finishedAt: null,
  dryRun: false,
  abortRequestedAt: null,
  unmonitoredMovies: 0,
  remonitoredMovies: 0,
  unmonitoredEps: 0,
  remonitoredEps: 0,
  deletedFiles: 0,
  removedMovies: 0,
  searchedItems: 0,
  error: null,
  log: null,
  ...over,
});

/** Every POST the page made, so "did it stop the run?" is answerable. */
let posted: string[] = [];

function serve(runs: ReturnType<typeof run>[], role: "ADMIN" | "USER" = "ADMIN") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        posted.push(url);
        return new Response(JSON.stringify({ ok: true, status: "requested" }), { status: 200 });
      }
      const body = url.startsWith("/api/auth/session") ? { user: { id: 1, role } } : { runs };
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
}

/** Render with a fresh SWR cache so tests cannot see each other's responses. */
const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RunsPage />
    </SWRConfig>
  );

beforeEach(() => {
  posted = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Runs page — aborting a run", () => {
  it("asks before it stops anything", async () => {
    serve([run({ id: 12, status: "RUNNING" })]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Abort run" }));

    // The first click only opens the question.
    expect(posted).toEqual([]);
    expect(screen.getByText(/Abort run #12\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Yes, abort it/ }));
    await waitFor(() => expect(posted).toEqual(["/api/runs/12/abort"]));
  });

  it("stops nothing when the question is declined", async () => {
    serve([run({ id: 12, status: "RUNNING" })]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Abort run" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));

    expect(screen.queryByText(/Abort run #12\?/)).toBeNull();
    expect(posted).toEqual([]);
  });

  it("says whether the run has already changed anything", async () => {
    serve([run({ id: 12, status: "RUNNING", dryRun: false })]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Abort run" }));
    expect(screen.getByText(/not undone/)).toBeTruthy();

    cleanup();
    serve([run({ id: 13, status: "RUNNING", dryRun: true })]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Abort run" }));
    expect(screen.getByText(/this run is a dry-run/)).toBeTruthy();
  });

  it("offers nothing to stop on a run that has already finished", async () => {
    serve([run({ id: 11, status: "SUCCESS" }), run({ id: 10, status: "ABORTED" })]);
    renderPage();

    expect(await screen.findByText("Run #11")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abort run" })).toBeNull();
  });

  it("shows a run that is already stopping, without offering to ask again", async () => {
    serve([run({ id: 12, status: "RUNNING", abortRequestedAt: "2026-08-10T12:01:00.000Z" })]);
    renderPage();

    const button = (await screen.findByRole("button", { name: "Stopping…" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("STOPPING")).toBeTruthy();
  });

  it("hides the control from a viewer who could not use it", async () => {
    serve([run({ id: 12, status: "RUNNING" })], "USER");
    renderPage();

    expect(await screen.findByText("Run #12")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abort run" })).toBeNull();
  });
});
