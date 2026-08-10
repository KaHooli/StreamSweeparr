// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MovieProviderCard } from "./MovieProviderCard";
import type { SettingsDto } from "./types";

/**
 * The card is one PATCH and some copy, so what is worth pinning is the part a
 * user acts on: which option reads as selected, that choosing one sends that
 * choice and nothing else, and that picking Watchmode without a Watchmode key
 * says so — the setting would otherwise look accepted while every movie came
 * back "unknown" on the next sync.
 */

const settings = (over: Partial<SettingsDto> = {}): SettingsDto =>
  ({
    secretsUnreadable: false,
    watchmodeApiKeySet: true,
    watchmodeApiKeyCount: 1,
    watchmodeApiKeyMax: 10,
    watchmodePlan: null,
    seerrUrl: "",
    seerrApiKeySet: false,
    countries: ["US"],
    serviceIds: [203],
    countedTypes: ["sub"],
    movieProvider: "TMDB",
    tmdbApiKeySet: true,
    tmdbRegions: ["US"],
    tmdbProviderIds: [8],
    tmdbCountedTypes: ["flatrate"],
    connections: [],
    ...over,
  }) as SettingsDto;

const tmdbOption = () => screen.getByRole("radio", { name: /Free and unmetered/ });
const watchmodeOption = () =>
  screen.getByRole("radio", { name: /One provider for the whole library/ });

/** Record every request; answer everything with an empty 200. */
function mockApi() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response(JSON.stringify({}), { status: 200 });
    })
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MovieProviderCard", () => {
  it("shows the stored provider as the selected one", () => {
    render(<MovieProviderCard settings={settings()} onChange={() => {}} />);

    expect((tmdbOption() as HTMLInputElement).checked).toBe(true);
    expect((watchmodeOption() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("TheMovieDB")).toBeTruthy();
  });

  it("saves the chosen provider, and only that", async () => {
    const calls = mockApi();
    const onChange = vi.fn();
    render(<MovieProviderCard settings={settings()} onChange={onChange} />);

    fireEvent.click(watchmodeOption());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/settings");
    // The TMDB key, regions and providers must survive the switch untouched.
    expect(calls[0].body).toEqual({ movieProvider: "WATCHMODE" });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("does not re-save the provider already in force", async () => {
    const calls = mockApi();
    render(<MovieProviderCard settings={settings()} onChange={() => {}} />);

    fireEvent.click(tmdbOption());

    expect(calls).toHaveLength(0);
  });

  it("warns when Watchmode is answering for movies with no Watchmode key", () => {
    render(
      <MovieProviderCard
        settings={settings({ movieProvider: "WATCHMODE", watchmodeApiKeySet: false })}
        onChange={() => {}}
      />
    );

    expect((watchmodeOption() as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/No Watchmode API key is set/)).toBeTruthy();
  });

  it("explains the longer freshness window once Watchmode is in use", () => {
    render(
      <MovieProviderCard settings={settings({ movieProvider: "WATCHMODE" })} onChange={() => {}} />
    );

    expect(screen.getByText(/re-checked at most once a week/)).toBeTruthy();
    expect(screen.queryByText(/No Watchmode API key is set/)).toBeNull();
  });
});
