"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import type { SettingsDto } from "@/components/settings/types";
import { WatchmodeCard } from "@/components/settings/WatchmodeCard";
import { TitleMapCard } from "@/components/settings/TitleMapCard";
import { CountriesCard } from "@/components/settings/CountriesCard";
import { ServicesCard } from "@/components/settings/ServicesCard";
import { TmdbCard } from "@/components/settings/TmdbCard";
import { TmdbRegionsCard } from "@/components/settings/TmdbRegionsCard";
import { TmdbProvidersCard } from "@/components/settings/TmdbProvidersCard";
import { SeerrCard } from "@/components/settings/SeerrCard";
import { ConnectionsCard } from "@/components/settings/ConnectionsCard";
import { OptionsCard } from "@/components/settings/OptionsCard";
import { ScheduleCard } from "@/components/settings/ScheduleCard";
import { AccountCard } from "@/components/settings/AccountCard";
import { LoginOptionsCard } from "@/components/settings/LoginOptionsCard";
import { UsersCard } from "@/components/settings/UsersCard";
import { OidcCard } from "@/components/settings/OidcCard";

/**
 * Settings shell: loads the settings payload once and renders the cards for
 * the active tab. Each card owns its own form state and saves independently —
 * they live in @/components/settings.
 */

type TabKey = "watchmode" | "tmdb" | "connections" | "run" | "account";

const TABS: { key: TabKey; label: string }[] = [
  { key: "watchmode", label: "Watchmode (TV)" },
  { key: "tmdb", label: "TheMovieDB (Movies)" },
  { key: "connections", label: "Connections" },
  { key: "run", label: "Run options" },
  { key: "account", label: "Users & security" },
];

export default function SettingsPage() {
  const {
    data: settings,
    error,
    isLoading,
    mutate,
  } = useSWR<SettingsDto>("/api/settings", fetcher);
  const [tab, setTab] = useState<TabKey>("watchmode");
  const status = (error as { status?: number } | undefined)?.status;
  const refresh = () => {
    void mutate();
  };

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

      {error ? (
        // Never leave the page stuck on "Loading…" — surface what went wrong.
        <div className="card">
          <div className="banner err">
            {status === 401
              ? "Your session expired. Please sign in again."
              : status === 403
              ? "This account is not an administrator, so settings can't be shown."
              : `Couldn't load settings: ${(error as Error).message}`}
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={() => mutate()}>
              Retry
            </button>
            {status === 401 && (
              <a className="btn" style={{ flex: "0 0 auto" }} href="/login">
                Go to sign in
              </a>
            )}
          </div>
        </div>
      ) : isLoading || !settings ? (
        <div className="card">Loading…</div>
      ) : (
        <>
          {tab === "watchmode" && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Watchmode provides per-episode streaming availability and is used for
                <strong> TV shows</strong>.
              </p>
              <WatchmodeCard settings={settings} onChange={refresh} />
              <TitleMapCard enabled={settings.watchmodeApiKeySet} />
              <CountriesCard settings={settings} onChange={refresh} />
              <ServicesCard settings={settings} onChange={refresh} />
            </>
          )}

          {tab === "tmdb" && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                TheMovieDB (JustWatch-powered) provides streaming availability and is used for
                <strong> movies</strong>.
              </p>
              <TmdbCard settings={settings} onChange={refresh} />
              <TmdbRegionsCard settings={settings} onChange={refresh} />
              <TmdbProvidersCard settings={settings} onChange={refresh} />
            </>
          )}

          {tab === "connections" && (
            <>
              <SeerrCard settings={settings} onChange={refresh} />
              <ConnectionsCard settings={settings} onChange={refresh} />
            </>
          )}

          {tab === "run" && (
            <>
              <OptionsCard settings={settings} onChange={refresh} />
              <ScheduleCard settings={settings} onChange={refresh} />
            </>
          )}

          {tab === "account" && (
            <>
              <AccountCard />
              <LoginOptionsCard settings={settings} onChange={refresh} />
              <UsersCard />
              <OidcCard settings={settings} onChange={refresh} />
            </>
          )}
        </>
      )}
    </main>
  );
}
