// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { WatchmodeCard } from "./WatchmodeCard";
import type { SettingsDto } from "./types";

/**
 * What matters here is the shape of the key ring in the UI: one field to start
 * with, numbered fields once several keys are stored, "Add another key" only
 * offered once every field on screen holds a saved key, and a save that refers
 * to untouched keys by position (their values never reach the browser).
 */

const settings = (over: Partial<SettingsDto> = {}): SettingsDto =>
  ({
    secretsUnreadable: false,
    watchmodeApiKeySet: false,
    watchmodeApiKeyCount: 0,
    watchmodeApiKeyMax: 10,
    watchmodePlan: null,
    watchmodeCacheDays: 7,
    watchmodeCacheChoices: [1, 2, 3, 5, 7, 14, 30, 60, 90],
    seerrUrl: "",
    seerrApiKeySet: false,
    countries: [],
    serviceIds: [],
    countedTypes: [],
    movieProvider: "TMDB",
    tmdbApiKeySet: false,
    tmdbRegions: [],
    tmdbProviderIds: [],
    tmdbCountedTypes: [],
    deleteFiles: true,
    purgeUnmonitoredFiles: false,
    searchAtEnd: true,
    removeMissingTmdbMovies: true,
    applyChanges: false,
    sweepScheduleEnabled: false,
    sweepIntervalHours: 12,
    sweepIntervalChoices: [12],
    sweepNextRunAt: null,
    sweepLastRunAt: null,
    sweepSchedulerDisabledByEnv: false,
    localLoginEnabled: true,
    localLoginEffective: true,
    localLoginLock: { locked: false, reason: null },
    oidcEnabled: false,
    oidcIssuer: "",
    oidcClientId: "",
    oidcClientSecretSet: false,
    oidcButtonLabel: "",
    oidcButtonLabelDefault: "Sign in with SSO",
    oidcScopes: "openid profile email",
    oidcAuthUrl: "",
    oidcTokenUrl: "",
    oidcUserinfoUrl: "",
    oidcAllowedUsers: [],
    connections: [],
    ...over,
  }) as SettingsDto;

/** Record every request, answering the test endpoint with per-key results. */
function mockApi(testKeys: { number: number; ok: boolean; quota?: number; quotaUsed?: number; error?: string }[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url === "/api/watchmode/test") {
      return new Response(JSON.stringify({ ok: testKeys.some((k) => k.ok), keys: testKeys }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const keyFields = () => screen.getAllByLabelText(/^API Key \d+$/);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WatchmodeCard", () => {
  it("offers a single field, and no way to add a second, until one is saved", () => {
    render(<WatchmodeCard settings={settings()} onChange={() => {}} />);

    expect(keyFields()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /add another key/i })).toBeNull();
    // Nothing to remove when there is only one field.
    expect(screen.queryByRole("button", { name: /remove api key/i })).toBeNull();
  });

  it("shows one numbered, masked field per stored key", () => {
    render(<WatchmodeCard settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 3 })} onChange={() => {}} />);

    const fields = keyFields();
    expect(fields).toHaveLength(3);
    expect(fields.every((f) => (f as HTMLInputElement).value === "")).toBe(true);
    expect((fields[0] as HTMLInputElement).placeholder).toContain("saved");
    expect(screen.getByText("3 keys")).toBeTruthy();
  });

  it("offers Add another key once every field holds a saved key", () => {
    render(<WatchmodeCard settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 1 })} onChange={() => {}} />);

    const add = screen.getByRole("button", { name: /add another key/i });
    fireEvent.click(add);

    expect(keyFields()).toHaveLength(2);
    // The new field is empty, so there is nothing to add another key after yet.
    expect(screen.queryByRole("button", { name: /add another key/i })).toBeNull();
  });

  it("hides Add another key at the maximum", () => {
    render(
      <WatchmodeCard
        settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 2, watchmodeApiKeyMax: 2 })}
        onChange={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: /add another key/i })).toBeNull();
    expect(screen.getByText(/maximum of 2 keys/i)).toBeTruthy();
  });

  it("saves stored keys by position and new keys by value", async () => {
    const calls = mockApi([
      { number: 1, ok: true, quota: 1000, quotaUsed: 10 },
      { number: 2, ok: true, quota: 1000, quotaUsed: 0 },
    ]);
    const onChange = vi.fn();
    render(<WatchmodeCard settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 1 })} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /add another key/i }));
    fireEvent.change(keyFields()[1], { target: { value: " second-key " } });
    fireEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Validated first, then saved — both with the same ring.
    const entries = [{ keep: 1 }, { value: "second-key" }];
    expect(calls[0]).toEqual({ url: "/api/watchmode/test", body: { apiKeys: entries } });
    expect(calls[1]).toEqual({ url: "/api/settings", body: { watchmodeApiKeys: entries } });
    expect(screen.getByText(/Saved 2 keys — 2 working/)).toBeTruthy();
  });

  it("reports each key's quota, and which key is spent", async () => {
    mockApi([
      { number: 1, ok: false, error: "Watchmode rejected API key 1 (invalid or over quota)." },
      { number: 2, ok: true, quota: 1000, quotaUsed: 42 },
    ]);
    render(<WatchmodeCard settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 2 })} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /test & save/i }));

    // A spent key is still saved: covering it is what the rest of the ring is for.
    expect(await screen.findByText(/invalid or over quota/)).toBeTruthy();
    expect(screen.getByText(/quota 42\/1000 used/)).toBeTruthy();
  });

  it("drops a removed key from the saved ring", async () => {
    const calls = mockApi([{ number: 1, ok: true, quota: 1000, quotaUsed: 1 }]);
    render(<WatchmodeCard settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 2 })} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove API key 1" }));
    expect(keyFields()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /test & save/i }));
    await waitFor(() => expect(calls).toHaveLength(2));
    // Key 2 survives, and becomes key 1.
    expect(calls[1].body).toEqual({ watchmodeApiKeys: [{ keep: 2 }] });
  });

  it("refuses to save nothing", async () => {
    const calls = mockApi([]);
    render(<WatchmodeCard settings={settings()} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(await screen.findByText(/Enter at least one Watchmode API key/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("saves the cache window on its own, without touching the keys", async () => {
    const calls = mockApi([]);
    const onChange = vi.fn();
    render(
      <WatchmodeCard
        settings={settings({ watchmodeApiKeySet: true, watchmodeApiKeyCount: 1 })}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText(/cache lookups for/i), { target: { value: "30" } });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // No key test: the window is not a credential, so there is nothing to verify.
    expect(calls).toEqual([{ url: "/api/settings", body: { watchmodeCacheDays: 30 } }]);
    expect(screen.getByText(/re-checked after 30 days/)).toBeTruthy();
  });

  it("shows the configured window as what limits usage on a free plan", () => {
    render(
      <WatchmodeCard
        settings={settings({
          watchmodeApiKeySet: true,
          watchmodeApiKeyCount: 1,
          watchmodePlan: "free",
          watchmodeCacheDays: 14,
        })}
        onChange={() => {}}
      />
    );

    expect((screen.getByLabelText(/cache lookups for/i) as HTMLSelectElement).value).toBe("14");
    expect(screen.getByText(/14 days cache above is what limits API usage/)).toBeTruthy();
  });
});
