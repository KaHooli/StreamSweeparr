"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import type { SettingsDto } from "@/components/settings/types";
import { WatchmodeCard } from "@/components/settings/WatchmodeCard";
import { TitleMapCard } from "@/components/settings/TitleMapCard";
import { CountriesCard } from "@/components/settings/CountriesCard";
import { ServicesCard } from "@/components/settings/ServicesCard";
import { MovieProviderCard } from "@/components/settings/MovieProviderCard";
import { TmdbCard } from "@/components/settings/TmdbCard";
import { TmdbRegionsCard } from "@/components/settings/TmdbRegionsCard";
import { TmdbProvidersCard } from "@/components/settings/TmdbProvidersCard";
import { SeerrCard } from "@/components/settings/SeerrCard";
import { ConnectionsCard } from "@/components/settings/ConnectionsCard";
import { OptionsCard } from "@/components/settings/OptionsCard";
import { ScheduleCard } from "@/components/settings/ScheduleCard";
import { WebhookCard } from "@/components/settings/WebhookCard";
import { AccountCard } from "@/components/settings/AccountCard";
import { LoginOptionsCard } from "@/components/settings/LoginOptionsCard";
import { UsersCard } from "@/components/settings/UsersCard";
import { OidcCard } from "@/components/settings/OidcCard";
import { InfoCard } from "@/components/settings/InfoCard";
import { settingsTabs, resolveTab, type SettingsTabKey } from "@/lib/settingsTabs";

/**
 * Settings shell: loads the settings payload once and renders the cards for
 * the active tab. Each card owns its own form state and saves independently —
 * they live in @/components/settings.
 */

export default function SettingsPage() {
  const {
    data: settings,
    error,
    isLoading,
    mutate,
  } = useSWR<SettingsDto>("/api/settings", fetcher);
  // Info is admin-only, so the strip is built from the session rather than
  // being static. The API behind it is admin-guarded too — this only decides
  // what to show.
  const { data: session } = useSWR<{ user: { isAdmin?: boolean } | null }>(
    "/api/auth/session",
    fetcher
  );
  const tabs = settingsTabs({ isAdmin: !!session?.user?.isAdmin });
  const [selected, setSelected] = useState<SettingsTabKey>("watchmode");
  // Guards the gap before the session resolves, and a demotion mid-visit.
  const tab = resolveTab(selected, tabs);
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
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setSelected(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "info" ? (
        // Deliberately outside the settings fetch: Info is the tab you open
        // *because* something is broken, so it must render even when
        // /api/settings is the thing that's failing.
        <InfoCard />
      ) : error ? (
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
          {settings.secretsUnreadable && (
            // Without this the keys would just appear to have vanished, and the
            // obvious guess — "the database lost them" — is the wrong one.
            <div className="banner err">
              <strong>Stored credentials can&rsquo;t be decrypted.</strong> API keys are
              encrypted with a key derived from <code>AUTH_SECRET</code>, and it looks like
              that value changed. Restore the previous <code>AUTH_SECRET</code> to recover
              them, or re-enter the affected keys below to save them under the new one.
            </div>
          )}

          {tab === "watchmode" && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Watchmode provides per-episode streaming availability and is used for
                <strong> TV shows</strong>
                {settings.movieProvider === "WATCHMODE" ? (
                  <>
                    {" "}
                    and, because you chose it on the <strong>Movies</strong> tab,{" "}
                    <strong>movies</strong>
                  </>
                ) : null}
                . The countries and services below apply to everything it answers for.
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
                Movie streaming availability. TV always comes from Watchmode — only movies
                have a choice of provider.
              </p>
              <MovieProviderCard settings={settings} onChange={refresh} />
              {settings.movieProvider === "TMDB" ? (
                <>
                  <TmdbCard settings={settings} onChange={refresh} />
                  <TmdbRegionsCard settings={settings} onChange={refresh} />
                  <TmdbProvidersCard settings={settings} onChange={refresh} />
                </>
              ) : (
                // Hidden rather than disabled: with Watchmode answering movies
                // these say nothing about what a sweep will do, and a region
                // list that has no effect is worse than no region list. The
                // stored values are untouched and come back on switching back.
                <div className="card">
                  <p className="muted" style={{ margin: 0 }}>
                    Movies are being looked up on Watchmode, so the TheMovieDB key, regions
                    and providers aren&rsquo;t used. Pick the countries and services on the{" "}
                    <strong>Watchmode</strong> tab instead. Your TheMovieDB settings are kept
                    and reappear here if you switch back.
                  </p>
                </div>
              )}
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
              <WebhookCard settings={settings} onChange={refresh} />
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
