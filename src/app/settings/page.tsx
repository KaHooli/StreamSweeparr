"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, postJson, sendJson } from "@/lib/fetcher";

interface SettingsDto {
  watchmodeApiKeySet: boolean;
  watchmodePlan: "paid" | "free" | "unknown" | null;
  seerrUrl: string;
  seerrApiKeySet: boolean;
  countries: string[];
  serviceIds: number[];
  countedTypes: string[];
  tmdbApiKeySet: boolean;
  tmdbRegions: string[];
  tmdbProviderIds: number[];
  tmdbCountedTypes: string[];
  deleteFiles: boolean;
  searchAtEnd: boolean;
  applyChanges: boolean;
  oidcEnabled: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecretSet: boolean;
  oidcScopes: string;
  oidcAuthUrl: string;
  oidcTokenUrl: string;
  oidcUserinfoUrl: string;
  oidcAllowedUsers: string[];
  connections: { id: number; type: string; name: string; baseUrl: string; enabled: boolean; origin: string }[];
}
interface Region { code: string; name: string; flag: string }
interface Service { id: number; name: string; type: string; logo: string | null }
interface ServiceGroup { country: string; services: Service[] }

const TYPE_LABELS: Record<string, string> = {
  sub: "Subscription",
  free: "Free",
  purchase: "Purchase",
  rent: "Rent",
  tv_everywhere: "TV Everywhere",
};

// TMDB watch-provider categories.
const TMDB_TYPE_LABELS: Record<string, string> = {
  flatrate: "Subscription",
  free: "Free",
  ads: "Free with ads",
  rent: "Rent",
  buy: "Buy",
};

type TabKey = "watchmode" | "tmdb" | "connections" | "run" | "account";

const TABS: { key: TabKey; label: string }[] = [
  { key: "watchmode", label: "Watchmode (TV)" },
  { key: "tmdb", label: "TheMovieDB (Movies)" },
  { key: "connections", label: "Connections" },
  { key: "run", label: "Run options" },
  { key: "account", label: "Account & security" },
];

export default function SettingsPage() {
  const { data: settings, mutate } = useSWR<SettingsDto>("/api/settings", fetcher);
  const [tab, setTab] = useState<TabKey>("watchmode");

  return (
    <main>
      <div className="section-title">
        <h2>Settings</h2>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!settings ? (
        <div className="card">Loading…</div>
      ) : (
        <>
          {tab === "watchmode" && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Watchmode provides per-episode streaming availability and is used for
                <strong> TV shows</strong>.
              </p>
              <WatchmodeCard settings={settings} onChange={() => mutate()} />
              <TitleMapCard enabled={settings.watchmodeApiKeySet} />
              <CountriesCard settings={settings} onChange={() => mutate()} />
              <ServicesCard settings={settings} onChange={() => mutate()} />
            </>
          )}

          {tab === "tmdb" && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                TheMovieDB (JustWatch-powered) provides streaming availability and is used for
                <strong> movies</strong>.
              </p>
              <TmdbCard settings={settings} onChange={() => mutate()} />
              <TmdbRegionsCard settings={settings} onChange={() => mutate()} />
              <TmdbProvidersCard settings={settings} onChange={() => mutate()} />
            </>
          )}

          {tab === "connections" && (
            <>
              <SeerrCard settings={settings} onChange={() => mutate()} />
              <ConnectionsCard settings={settings} onChange={() => mutate()} />
            </>
          )}

          {tab === "run" && <OptionsCard settings={settings} onChange={() => mutate()} />}

          {tab === "account" && (
            <>
              <AccountCard />
              <OidcCard settings={settings} onChange={() => mutate()} />
            </>
          )}
        </>
      )}
    </main>
  );
}

/* --------------------------- Watchmode key --------------------------- */
function WatchmodeCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Validate first (uses provided key or existing saved one).
      const test = await postJson<{ ok: boolean; quota: number; quotaUsed: number; error?: string }>(
        "/api/watchmode/test",
        key ? { apiKey: key } : {}
      );
      if (key) await sendJson("PATCH", "/api/settings", { watchmodeApiKey: key });
      setMsg({
        kind: "ok",
        text: `Watchmode OK — quota ${test.quotaUsed}/${test.quota} used.`,
      });
      setKey("");
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Watchmode API</h2>
        <span className="count">{settings.watchmodeApiKeySet ? "configured" : "not set"}</span>
      </div>
      <div className="field">
        <label>API Key</label>
        <input
          className="input"
          type="password"
          placeholder={settings.watchmodeApiKeySet ? "•••••••• (saved) — enter to replace" : "Your Watchmode API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="hint">
          Get one at api.watchmode.com. Used to look up streaming availability by country.
        </div>
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : null} Test &amp; save
      </button>

      {settings.watchmodeApiKeySet && settings.watchmodePlan && (
        <div className="hint" style={{ marginTop: 12 }}>
          Detected plan:{" "}
          <strong style={{ color: settings.watchmodePlan === "paid" ? "var(--ok)" : "var(--text)" }}>
            {settings.watchmodePlan === "paid"
              ? "Paid (premium Changes API)"
              : settings.watchmodePlan === "free"
              ? "Free / Developer"
              : "Unknown"}
          </strong>
          {settings.watchmodePlan === "paid"
            ? " — change-detection is enabled, minimising API usage."
            : " — using a 7-day refresh cache to limit API usage. A paid plan enables change-detection for near-zero ongoing usage."}
        </div>
      )}

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

/* -------------------------- Title ID map ---------------------------- */
interface TitleMapDto {
  syncedAt: string | null;
  etag: string | null;
  lastModified: string | null;
  rowCount: number;
}
function TitleMapCard({ enabled }: { enabled: boolean }) {
  const { data, mutate } = useSWR<TitleMapDto>("/api/titlemap", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = async (force: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ result: { status: string; rowCount: number } }>(
        "/api/titlemap",
        { force }
      );
      setMsg({
        kind: "ok",
        text: `${r.result.status} — ${r.result.rowCount.toLocaleString()} titles in map.`,
      });
      mutate();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Title ID map</h2>
        <span className="count">{data?.rowCount ? `${data.rowCount.toLocaleString()} titles` : "empty"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Local copy of Watchmode&apos;s TMDB/IMDB → Watchmode ID dataset. Auto-refreshes every 12
        hours (only re-imports when the dataset&apos;s ETag changes) so lookups don&apos;t spend
        Watchmode search quota.
      </p>
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat" style={{ padding: 12 }}>
          <div className="label">Last import</div>
          <div className="value" style={{ fontSize: 15 }}>
            {data?.syncedAt ? new Date(data.syncedAt).toLocaleString() : "never"}
          </div>
        </div>
        <div className="stat" style={{ padding: 12 }}>
          <div className="label">Dataset date</div>
          <div className="value" style={{ fontSize: 15 }}>
            {data?.lastModified ? new Date(data.lastModified).toLocaleString() : "—"}
          </div>
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={() => refresh(false)} disabled={busy || !enabled}>
          {busy ? <span className="spin" /> : null} Refresh (if changed)
        </button>
        <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={() => refresh(true)} disabled={busy || !enabled}>
          {busy ? <span className="spin" /> : null} Force re-import
        </button>
      </div>
      {!enabled && <div className="muted" style={{ marginTop: 8 }}>Add a Watchmode API key first.</div>}
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

/* ----------------------------- Countries ----------------------------- */
function CountriesCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const { data, error } = useSWR<{ regions: Region[] }>(
    settings.watchmodeApiKeySet ? "/api/watchmode/regions" : null,
    fetcher
  );
  const [selected, setSelected] = useState<string[]>(settings.countries);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(settings.countries), [settings.countries]);

  const toggle = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", { countries: selected });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Countries (TV)</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.watchmodeApiKeySet && <div className="muted">Add a Watchmode API key first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}
      {data && (
        <>
          <div className="pills">
            {data.regions.map((r) => (
              <div
                key={r.code}
                className={`pill ${selected.includes(r.code) ? "selected" : ""}`}
                onClick={() => toggle(r.code)}
                role="checkbox"
                aria-checked={selected.includes(r.code)}
              >
                <span className="flag">{r.flag}</span>
                <span>{r.name}</span>
              </div>
            ))}
          </div>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
            {saving ? <span className="spin" /> : null} Save countries
          </button>
        </>
      )}
    </div>
  );
}

/* ----------------------------- Services ------------------------------ */
function ServicesCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const key =
    settings.watchmodeApiKeySet && settings.countries.length
      ? `/api/watchmode/sources?countries=${settings.countries.join(",")}`
      : null;
  const { data, error } = useSWR<{ groups: ServiceGroup[] }>(key, fetcher);
  const [selected, setSelected] = useState<number[]>(settings.serviceIds);
  const [types, setTypes] = useState<string[]>(settings.countedTypes);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(settings.serviceIds), [settings.serviceIds]);
  useEffect(() => setTypes(settings.countedTypes), [settings.countedTypes]);

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleType = (t: string) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", { serviceIds: selected, countedTypes: types });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Streaming services (TV)</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.countries.length && <div className="muted">Select at least one country first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}

      <div className="field">
        <label>Count a title as &quot;on streaming&quot; when available via:</label>
        <div className="chips">
          {Object.entries(TYPE_LABELS).map(([t, label]) => (
            <span
              key={t}
              className="chip"
              style={{
                cursor: "pointer",
                borderColor: types.includes(t) ? "var(--accent)" : undefined,
                color: types.includes(t) ? "var(--accent)" : undefined,
              }}
              onClick={() => toggleType(t)}
            >
              {types.includes(t) ? "✓ " : ""}
              {label}
            </span>
          ))}
        </div>
      </div>

      {data &&
        data.groups.map((g) => (
          <div key={g.country}>
            <div className="group-head">Streaming in {g.country}</div>
            <div className="pills">
              {g.services.map((s) => (
                <div
                  key={s.id}
                  className={`pill ${selected.includes(s.id) ? "selected" : ""}`}
                  onClick={() => toggle(s.id)}
                  role="checkbox"
                  aria-checked={selected.includes(s.id)}
                >
                  {s.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="logo" src={s.logo} alt={s.name} />
                  ) : (
                    <span className="flag">▦</span>
                  )}
                  <span>{s.name}</span>
                  <span className="svc-type">{s.type}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      {data && (
        <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
          {saving ? <span className="spin" /> : null} Save services
        </button>
      )}
    </div>
  );
}

/* ----------------------------- TMDB key ------------------------------ */
function TmdbCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await postJson<{ ok: boolean; error?: string }>(
        "/api/tmdb/test",
        key ? { apiKey: key } : {}
      );
      if (key) await sendJson("PATCH", "/api/settings", { tmdbApiKey: key });
      setMsg({ kind: "ok", text: "TMDB key is valid and saved." });
      setKey("");
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>TheMovieDB API</h2>
        <span className="count">{settings.tmdbApiKeySet ? "configured" : "not set"}</span>
      </div>
      <div className="field">
        <label>API Key (v3)</label>
        <input
          className="input"
          type="password"
          placeholder={settings.tmdbApiKeySet ? "•••••••• (saved) — enter to replace" : "Your TMDB API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="hint">
          Create one for free at themoviedb.org → Settings → API. Used for movie streaming
          availability (JustWatch data).
        </div>
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : null} Test &amp; save
      </button>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

/* --------------------------- TMDB regions ---------------------------- */
function TmdbRegionsCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const { data, error } = useSWR<{ regions: Region[] }>(
    settings.tmdbApiKeySet ? "/api/tmdb/regions" : null,
    fetcher
  );
  const [selected, setSelected] = useState<string[]>(settings.tmdbRegions);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(settings.tmdbRegions), [settings.tmdbRegions]);

  const toggle = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", { tmdbRegions: selected });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Watch provider regions (Movies)</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.tmdbApiKeySet && <div className="muted">Add a TMDB API key first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}
      {data && (
        <>
          <div className="pills">
            {data.regions.map((r) => (
              <div
                key={r.code}
                className={`pill ${selected.includes(r.code) ? "selected" : ""}`}
                onClick={() => toggle(r.code)}
                role="checkbox"
                aria-checked={selected.includes(r.code)}
              >
                <span className="flag">{r.flag}</span>
                <span>{r.name}</span>
              </div>
            ))}
          </div>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
            {saving ? <span className="spin" /> : null} Save regions
          </button>
        </>
      )}
    </div>
  );
}

/* -------------------------- TMDB providers --------------------------- */
interface TmdbProviderGroup {
  region: string;
  services: { id: number; name: string; logo: string | null }[];
}
function TmdbProvidersCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const key =
    settings.tmdbApiKeySet && settings.tmdbRegions.length
      ? `/api/tmdb/providers?regions=${settings.tmdbRegions.join(",")}`
      : null;
  const { data, error } = useSWR<{ groups: TmdbProviderGroup[] }>(key, fetcher);
  const [selected, setSelected] = useState<number[]>(settings.tmdbProviderIds);
  const [types, setTypes] = useState<string[]>(settings.tmdbCountedTypes);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(settings.tmdbProviderIds), [settings.tmdbProviderIds]);
  useEffect(() => setTypes(settings.tmdbCountedTypes), [settings.tmdbCountedTypes]);

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleType = (t: string) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", {
      tmdbProviderIds: selected,
      tmdbCountedTypes: types,
    });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Movie providers</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.tmdbRegions.length && <div className="muted">Select at least one region first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}

      <div className="field">
        <label>Count a movie as &quot;on streaming&quot; when available via:</label>
        <div className="chips">
          {Object.entries(TMDB_TYPE_LABELS).map(([t, label]) => (
            <span
              key={t}
              className="chip"
              style={{
                cursor: "pointer",
                borderColor: types.includes(t) ? "var(--accent)" : undefined,
                color: types.includes(t) ? "var(--accent)" : undefined,
              }}
              onClick={() => toggleType(t)}
            >
              {types.includes(t) ? "✓ " : ""}
              {label}
            </span>
          ))}
        </div>
      </div>

      {data &&
        data.groups.map((g) => (
          <div key={g.region}>
            <div className="group-head">Available in {g.region}</div>
            <div className="pills">
              {g.services.map((s) => (
                <div
                  key={s.id}
                  className={`pill ${selected.includes(s.id) ? "selected" : ""}`}
                  onClick={() => toggle(s.id)}
                  role="checkbox"
                  aria-checked={selected.includes(s.id)}
                >
                  {s.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="logo" src={s.logo} alt={s.name} />
                  ) : (
                    <span className="flag">▦</span>
                  )}
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      {data && (
        <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
          {saving ? <span className="spin" /> : null} Save providers
        </button>
      )}
    </div>
  );
}

/* ------------------------------- Seerr ------------------------------- */
function SeerrCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const [url, setUrl] = useState(settings.seerrUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "save" | "discover">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => setUrl(settings.seerrUrl), [settings.seerrUrl]);

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", {
        seerrUrl: url,
        ...(apiKey ? { seerrApiKey: apiKey } : {}),
      });
      setApiKey("");
      setMsg({ kind: "ok", text: "Saved Seerr connection." });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    setBusy("discover");
    setMsg(null);
    try {
      const r = await postJson<{ discovered: number }>("/api/connections/discover");
      setMsg({ kind: "ok", text: `Discovered ${r.discovered} instance(s) from Seerr.` });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Seerr (optional)</h2>
        <span className="count">{settings.seerrApiKeySet ? "configured" : "not set"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Point at your Seerr server to auto-discover its Sonarr/Radarr instances. You can also add
        instances manually below.
      </p>
      <div className="row">
        <div className="field">
          <label>Seerr URL</label>
          <input className="input" placeholder="https://seerr.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>Seerr API Key</label>
          <input
            className="input"
            type="password"
            placeholder={settings.seerrApiKeySet ? "•••••••• (saved)" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={save} disabled={!!busy}>
          {busy === "save" ? <span className="spin" /> : null} Save
        </button>
        <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={discover} disabled={!!busy || !settings.seerrApiKeySet}>
          {busy === "discover" ? <span className="spin" /> : null} Discover instances
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

/* ---------------------------- Connections ---------------------------- */
function ConnectionsCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const [type, setType] = useState("SONARR");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/connections", { type, name, baseUrl, apiKey });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setMsg({ kind: "ok", text: "Connection added & verified." });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    await sendJson("DELETE", `/api/connections/${id}`);
    onChange();
  };
  const toggleEnabled = async (id: number, enabled: boolean) => {
    await sendJson("PATCH", `/api/connections/${id}`, { enabled });
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Sonarr / Radarr connections</h2>
        <span className="count">{settings.connections.length} configured</span>
      </div>

      <div className="conn-list" style={{ marginBottom: 18 }}>
        {settings.connections.length === 0 && <div className="muted">No connections yet.</div>}
        {settings.connections.map((c) => (
          <div className="conn" key={c.id}>
            <span className={`type ${c.type}`}>{c.type}</span>
            <div style={{ flex: 1 }}>
              <strong>{c.name}</strong>
              <div className="muted">{c.baseUrl} · {c.origin}</div>
            </div>
            <label className="switch" title={c.enabled ? "Enabled" : "Disabled"}>
              <input type="checkbox" checked={c.enabled} onChange={(e) => toggleEnabled(c.id, e.target.checked)} />
              <span className="slider" />
            </label>
            <button className="btn danger sm" onClick={() => remove(c.id)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="group-head">Add manually</div>
      <div className="row">
        <div className="field">
          <label>Type</label>
          <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="SONARR">Sonarr (TV)</option>
            <option value="RADARR">Radarr (Movies)</option>
          </select>
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" placeholder="Main Sonarr" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>URL</label>
          <input className="input" placeholder="http://localhost:8989" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>API Key</label>
          <input className="input" type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
      </div>
      <button className="btn primary" onClick={add} disabled={busy || !name || !baseUrl || !apiKey}>
        {busy ? <span className="spin" /> : null} Add &amp; test connection
      </button>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

/* ------------------------------ Options ------------------------------ */
function OptionsCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const set = async (patch: Partial<SettingsDto>) => {
    await sendJson("PATCH", "/api/settings", patch);
    onChange();
  };
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Run options</h2>
      </div>
      <Toggle
        title="Apply changes (LIVE mode)"
        desc="When off, sweeps are a dry-run and never modify Sonarr/Radarr."
        checked={settings.applyChanges}
        danger
        onChange={(v) => set({ applyChanges: v })}
      />
      <Toggle
        title="Delete files when unmonitoring"
        desc="Delete the episode/movie file after unmonitoring a title that's on streaming."
        checked={settings.deleteFiles}
        onChange={(v) => set({ deleteFiles: v })}
      />
      <Toggle
        title="Search monitored items at end of run"
        desc="Trigger a search for every monitored movie/episode after sweeping."
        checked={settings.searchAtEnd}
        onChange={(v) => set({ searchAtEnd: v })}
      />
    </div>
  );
}

function Toggle({
  title,
  desc,
  checked,
  onChange,
  danger,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
}) {
  return (
    <div className="toggle-line">
      <div className="txt">
        <strong style={danger ? { color: "var(--danger)" } : undefined}>{title}</strong>
        <span>{desc}</span>
      </div>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="slider" />
      </label>
    </div>
  );
}

/* ------------------------------ Account ------------------------------ */
function AccountCard() {
  const { data: session } = useSWR<{ user: { username: string; method: string } | null }>(
    "/api/auth/session",
    fetcher
  );
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    if (next !== confirm) {
      setMsg({ kind: "err", text: "New passwords do not match." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/auth/change-password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ kind: "ok", text: "Password updated." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Account &amp; security</h2>
        <span className="count">{session?.user ? session.user.username : ""}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Change the login password. The default admin account is{" "}
        <code>admin</code> — change its password on first login.
      </p>
      <div className="row">
        <div className="field">
          <label>Current password</label>
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>New password</label>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <div className="hint">At least 8 characters.</div>
        </div>
        <div className="field">
          <label>Confirm new password</label>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
      </div>
      <button className="btn primary" onClick={save} disabled={busy || !next}>
        {busy ? <span className="spin" /> : null} Update password
      </button>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

/* -------------------------------- OIDC ------------------------------- */
function OidcCard({ settings, onChange }: { settings: SettingsDto; onChange: () => void }) {
  const [enabled, setEnabled] = useState(settings.oidcEnabled);
  const [issuer, setIssuer] = useState(settings.oidcIssuer);
  const [clientId, setClientId] = useState(settings.oidcClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(settings.oidcScopes);
  const [authUrl, setAuthUrl] = useState(settings.oidcAuthUrl);
  const [tokenUrl, setTokenUrl] = useState(settings.oidcTokenUrl);
  const [userinfoUrl, setUserinfoUrl] = useState(settings.oidcUserinfoUrl);
  const [allowed, setAllowed] = useState(settings.oidcAllowedUsers.join(", "));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    setEnabled(settings.oidcEnabled);
    setIssuer(settings.oidcIssuer);
    setClientId(settings.oidcClientId);
    setScopes(settings.oidcScopes);
    setAuthUrl(settings.oidcAuthUrl);
    setTokenUrl(settings.oidcTokenUrl);
    setUserinfoUrl(settings.oidcUserinfoUrl);
    setAllowed(settings.oidcAllowedUsers.join(", "));
  }, [settings]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", {
        oidcEnabled: enabled,
        oidcIssuer: issuer,
        oidcClientId: clientId,
        ...(clientSecret ? { oidcClientSecret: clientSecret } : {}),
        oidcScopes: scopes,
        oidcAuthUrl: authUrl,
        oidcTokenUrl: tokenUrl,
        oidcUserinfoUrl: userinfoUrl,
        oidcAllowedUsers: allowed
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setClientSecret("");
      setMsg({ kind: "ok", text: "OIDC settings saved." });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Authoritative redirect URI as the server will actually send it (accounts
  // for PUBLIC_URL / OIDC_REDIRECT_URI / reverse-proxy headers). Fall back to
  // the browser origin while loading.
  const { data: redirectData } = useSWR<{ redirectUri: string }>(
    "/api/auth/oidc/redirect-uri",
    fetcher
  );
  const redirectUri =
    redirectData?.redirectUri ||
    (typeof window !== "undefined" ? `${window.location.origin}/api/auth/oidc/callback` : "");

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Single sign-on (OIDC)</h2>
        <span className="count">{settings.oidcEnabled ? "enabled" : "disabled"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Optional. When enabled and configured, a <strong>Sign in with SSO</strong> button appears on
        the login page. Endpoints are auto-discovered from the issuer&apos;s{" "}
        <code>/.well-known/openid-configuration</code>.
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        Register the <strong>exact</strong> Redirect URI below with your provider. If StreamSweeparr
        runs behind a reverse proxy, set the <code>PUBLIC_URL</code> environment variable to your
        public URL so this matches.
      </p>

      <div className="toggle-line" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="txt">
          <strong>Enable OIDC</strong>
          <span>Show the SSO button and accept OIDC logins.</span>
        </div>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label>Redirect URI (register this with your provider)</label>
        <input className="input" readOnly value={redirectUri} onFocus={(e) => e.currentTarget.select()} />
      </div>

      <div className="field">
        <label>Issuer URL</label>
        <input className="input" placeholder="https://auth.example.com/realms/main" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
      </div>
      <div className="row">
        <div className="field">
          <label>Client ID</label>
          <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="field">
          <label>Client Secret</label>
          <input
            className="input"
            type="password"
            placeholder={settings.oidcClientSecretSet ? "•••••••• (saved)" : "Client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>Scopes</label>
        <input className="input" value={scopes} onChange={(e) => setScopes(e.target.value)} />
        <div className="hint">Space-separated. Default: openid profile email</div>
      </div>
      <div className="field">
        <label>Allowed users (optional)</label>
        <input
          className="input"
          placeholder="alice@example.com, bob"
          value={allowed}
          onChange={(e) => setAllowed(e.target.value)}
        />
        <div className="hint">
          Comma-separated emails / usernames. Leave empty to allow any authenticated OIDC user.
        </div>
      </div>

      <button className="btn ghost sm" onClick={() => setShowAdvanced((v) => !v)} type="button">
        {showAdvanced ? "Hide" : "Show"} endpoint overrides
      </button>
      {showAdvanced && (
        <div style={{ marginTop: 12 }}>
          <div className="field">
            <label>Authorization endpoint</label>
            <input className="input" value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} placeholder="(auto-discovered)" />
          </div>
          <div className="field">
            <label>Token endpoint</label>
            <input className="input" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="(auto-discovered)" />
          </div>
          <div className="field">
            <label>Userinfo endpoint</label>
            <input className="input" value={userinfoUrl} onChange={(e) => setUserinfoUrl(e.target.value)} placeholder="(auto-discovered)" />
          </div>
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <span className="spin" /> : null} Save OIDC settings
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
