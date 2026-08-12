"use client";

import { useState } from "react";
import { postJson, sendJson } from "@/lib/fetcher";
import type { WatchmodeKeyEntry } from "@/lib/watchmodeKeys";
import {
  WATCHMODE_CACHE_CHOICES,
  DEFAULT_WATCHMODE_CACHE_DAYS,
  describeWatchmodeCache,
  watchmodeCacheDisabled,
  watchmodeCacheOptionLabel,
} from "@/lib/watchmodeCache";
import type { CardProps } from "./types";

/**
 * Watchmode credentials and how long their answers are cached.
 *
 * A free Watchmode key carries a small monthly credit budget, so the card holds
 * a numbered ring of keys rather than a single field: sync starts at key 1 and
 * moves to the next key when one is rejected or spent. There is one field to
 * begin with; "Add another key" only appears once every field on screen is a
 * key that has been saved, so the ring can't grow into a row of empty boxes.
 *
 * The cache window sits alongside the keys because it is the other half of the
 * same budget: keys set how many credits exist, the window sets how fast they
 * are spent. It saves on its own (it is not a credential and needs no test
 * call), so changing it does not drag the key fields through a save.
 */

/**
 * One field. `keep` is the 1-based position of the stored key this field stands
 * for (null for a field the user has just added); `value` is a newly typed key,
 * empty when the stored one is being left alone. Stored keys are never sent to
 * the browser, which is why an untouched field is saved by position.
 */
interface Slot {
  keep: number | null;
  value: string;
}

interface KeyTestResult {
  number: number;
  ok: boolean;
  quota?: number;
  quotaUsed?: number;
  error?: string;
}

/** One masked field per stored key, or a single empty field when there are none. */
function slotsForCount(count: number): Slot[] {
  if (count < 1) return [{ keep: null, value: "" }];
  return Array.from({ length: count }, (_, i) => ({ keep: i + 1, value: "" }));
}

export function WatchmodeCard({ settings, onChange }: CardProps) {
  const count = settings.watchmodeApiKeyCount;
  const max = settings.watchmodeApiKeyMax;
  const [slots, setSlots] = useState<Slot[]>(() => slotsForCount(count));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [results, setResults] = useState<KeyTestResult[] | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);

  // Re-seed when the stored ring changes underneath us (first load, or a save
  // that added or removed a key), adjusting state during render as `lib/
  // useSyncedState` explains. Keyed on the count, so typing — which never
  // changes it — is left alone.
  const [seededCount, setSeededCount] = useState(count);
  if (seededCount !== count) {
    setSeededCount(count);
    setSlots(slotsForCount(count));
  }

  const setSlot = (index: number, value: string) =>
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, value } : s)));

  const addSlot = () => setSlots((prev) => [...prev, { keep: null, value: "" }]);

  const removeSlot = (index: number) => {
    setSlots((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
    setResults(null);
    setMsg(null);
  };

  // A field counts as populated once it holds a saved key; only then is there
  // something to add another key *after*.
  const allSaved = slots.every((s) => s.keep !== null && !s.value.trim());
  const canAdd = allSaved && slots.length < max;

  const save = async () => {
    // Drop fields that are neither a stored key nor newly typed.
    const entries: WatchmodeKeyEntry[] = slots
      .map((s): WatchmodeKeyEntry | null => {
        const typed = s.value.trim();
        if (typed) return { value: typed };
        if (s.keep !== null) return { keep: s.keep };
        return null;
      })
      .filter((e): e is WatchmodeKeyEntry => e !== null);

    if (!entries.length) {
      setMsg({ kind: "err", text: "Enter at least one Watchmode API key." });
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      // Validate first — this also tells the user which keys still have credit.
      // The save goes ahead as long as one key works: a key that is merely out
      // of quota is exactly what the rest of the ring exists to cover.
      const test = await postJson<{ ok: boolean; keys: KeyTestResult[] }>(
        "/api/watchmode/test",
        { apiKeys: entries }
      );
      await sendJson("PATCH", "/api/settings", { watchmodeApiKeys: entries });
      setResults(test.keys);
      const working = test.keys.filter((k) => k.ok).length;
      setMsg({
        kind: "ok",
        text:
          test.keys.length === 1
            ? "Watchmode key saved."
            : `Saved ${test.keys.length} keys — ${working} working.`,
      });
      onChange();
    } catch (e) {
      setResults(null);
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveCacheDays = async (days: number) => {
    setCacheBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", { watchmodeCacheDays: days });
      setMsg({
        kind: "ok",
        text: watchmodeCacheDisabled(days)
          ? "Caching is off — every sync will look up every title again."
          : `Watchmode answers will now be re-checked after ${describeWatchmodeCache(days)}.`,
      });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setCacheBusy(false);
    }
  };

  // Fall back to the built-in list if the server sent none (an older build).
  const cacheChoices = settings.watchmodeCacheChoices?.length
    ? settings.watchmodeCacheChoices
    : [...WATCHMODE_CACHE_CHOICES];
  const cacheDays = settings.watchmodeCacheDays ?? DEFAULT_WATCHMODE_CACHE_DAYS;
  const cacheOff = watchmodeCacheDisabled(cacheDays);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Watchmode API</h2>
        <span className="count">
          {count === 0 ? "not set" : count === 1 ? "1 key" : `${count} keys`}
        </span>
      </div>

      {slots.map((slot, i) => (
        <div className="field" key={i}>
          <label htmlFor={`watchmode-key-${i + 1}`}>API Key {i + 1}</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id={`watchmode-key-${i + 1}`}
              className="input"
              style={{ flex: 1 }}
              type="password"
              autoComplete="off"
              placeholder={
                slot.keep !== null
                  ? "•••••••• (saved) — enter to replace"
                  : "Your Watchmode API key"
              }
              value={slot.value}
              onChange={(e) => setSlot(i, e.target.value)}
            />
            {slots.length > 1 && (
              <button
                className="btn danger sm"
                onClick={() => removeSlot(i)}
                disabled={busy}
                aria-label={`Remove API key ${i + 1}`}
              >
                Remove
              </button>
            )}
          </div>
          {i === slots.length - 1 && (
            <div className="hint">
              Get one at api.watchmode.com. Used to look up streaming availability by country.
              {slots.length > 1
                ? " Keys are used in order: each request starts at key 1 and moves to the next one when a key runs out of credit."
                : ""}
            </div>
          )}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <span className="spin" /> : null} Test &amp; save
        </button>
        {canAdd && (
          <button className="btn" onClick={addSlot} disabled={busy}>
            + Add another key
          </button>
        )}
      </div>

      {allSaved && slots.length >= max && (
        <div className="hint" style={{ marginTop: 8 }}>
          Maximum of {max} keys reached.
        </div>
      )}

      {results && results.length > 0 && (
        <div className="hint" style={{ marginTop: 12 }}>
          {results.map((r) => (
            <div key={r.number}>
              Key {r.number}:{" "}
              {r.ok ? (
                <span>
                  quota {r.quotaUsed}/{r.quota} used
                </span>
              ) : (
                <span className="err-text">{r.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="watchmode-cache-days">Cache lookups for</label>
        <select
          id="watchmode-cache-days"
          className="select"
          value={cacheDays}
          disabled={cacheBusy}
          onChange={(e) => saveCacheDays(Number(e.target.value))}
        >
          {cacheChoices.map((d) => (
            <option key={d} value={d}>
              {watchmodeCacheOptionLabel(d)}
              {d === DEFAULT_WATCHMODE_CACHE_DAYS ? " (default)" : ""}
            </option>
          ))}
        </select>
        <div className="hint">
          How long an answer is kept before that title is looked up again — series episodes,
          provider links, and movies when Watchmode is answering those too. The default of{" "}
          {describeWatchmodeCache(DEFAULT_WATCHMODE_CACHE_DAYS)} is what a free / developer
          key&rsquo;s monthly credit budget is sized for. A shorter window notices a title
          arriving on streaming sooner and spends credits faster; a longer one is the way to
          fit a large library into a small budget.
        </div>
      </div>

      {cacheOff && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          Caching is off, so <strong>every sync spends a credit on every title</strong> — one
          per series, plus one per movie if Watchmode is answering for movies. Change
          detection can&rsquo;t save anything either, because nothing is eligible to be
          skipped. Use this only with credits to spare, or while chasing a stale snapshot.
        </div>
      )}

      {count > 0 && settings.watchmodePlan && (
        <div className="hint" style={{ marginTop: 12 }}>
          Detected plan:{" "}
          <strong style={{ color: settings.watchmodePlan === "paid" ? "var(--ok)" : "var(--text)" }}>
            {settings.watchmodePlan === "paid"
              ? "Paid (premium Changes API)"
              : settings.watchmodePlan === "free"
              ? "Free / Developer"
              : "Unknown"}
          </strong>
          {cacheOff
            ? " — with caching off, neither this nor change-detection reduces usage: every title is looked up on every sync."
            : settings.watchmodePlan === "paid"
            ? ` — change-detection is enabled, minimising API usage; the ${describeWatchmodeCache(
                cacheDays
              )} cache above is its safety net.`
            : ` — no Changes API on this plan, so the ${describeWatchmodeCache(
                cacheDays
              )} cache above is what limits API usage. A paid plan enables change-detection for near-zero ongoing usage.`}
        </div>
      )}

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
