/**
 * The Watchmode key ring: an ordered list of API keys, numbered 1..n.
 *
 * A free Watchmode key comes with a small monthly credit budget, so users with
 * a large library can legitimately hold several. The rule everywhere is the
 * same: start at key 1 and move to the next key only once the current one is
 * rejected or out of quota (`WatchmodeClient` implements that failover). Being
 * rate limited is not one of those reasons — it says nothing about the key, so
 * it is waited out with the ring intact (`lib/providerThrottle.ts`).
 *
 * This module owns the shape of that list — how it is normalised, how the
 * legacy single-key column folds into it, and how the settings UI describes an
 * edit to it. It deliberately holds no I/O so both the client bundle and the
 * API routes can import it.
 */
import { z } from "zod";

/**
 * Upper bound on stored keys. Nothing technical forces a limit; this keeps a
 * mis-scripted PATCH from growing the row without bound and keeps the Settings
 * card readable.
 */
export const MAX_WATCHMODE_KEYS = 10;

/**
 * Trim, drop blanks, and drop duplicates while preserving order.
 *
 * De-duplication matters for failover: the same key twice would mean the ring
 * "moves on" to a key that is already exhausted, wasting a request each time.
 */
export function normalizeWatchmodeKeys(
  keys: readonly (string | null | undefined)[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The effective key ring for a settings row.
 *
 * Falls back to the legacy single-key column when the array is empty, so an
 * install whose data migration has not run (or a row written by an older build)
 * still works.
 */
export function watchmodeKeys(s: {
  watchmodeApiKeys?: readonly (string | null)[] | null;
  watchmodeApiKey?: string | null;
}): string[] {
  const fromArray = normalizeWatchmodeKeys(s.watchmodeApiKeys ?? []);
  if (fromArray.length) return fromArray;
  return normalizeWatchmodeKeys([s.watchmodeApiKey]);
}

/**
 * One slot in an edit of the key ring, as sent by the Settings card.
 *
 * Stored keys are never sent back to the browser, so an edit cannot simply be a
 * list of strings: a slot the user did not touch has to be referred to by the
 * position it currently occupies. `{ keep: n }` means "the key stored at
 * position n", which makes removing and reordering unambiguous — the payload
 * is the desired ring in full, not a diff.
 */
export const watchmodeKeyEntrySchema = z.union([
  z.object({ value: z.string().min(1, "API key must not be empty.") }),
  z.object({ keep: z.number().int().min(1, "Key numbers start at 1.") }),
]);

export type WatchmodeKeyEntry = z.infer<typeof watchmodeKeyEntrySchema>;

export const watchmodeKeyEntriesSchema = z
  .array(watchmodeKeyEntrySchema)
  .max(MAX_WATCHMODE_KEYS, `At most ${MAX_WATCHMODE_KEYS} Watchmode API keys can be stored.`);

/** Raised when an edit refers to a stored key that is no longer there. */
export class WatchmodeKeyEntryError extends Error {}

/**
 * Turn an edit into the plaintext key ring it describes, resolving `keep`
 * slots against the currently stored (decrypted) keys.
 *
 * Throws `WatchmodeKeyEntryError` when a slot points at a key that does not
 * exist — that means the caller is working from a stale view of the settings,
 * and silently dropping the slot would delete a key the user meant to keep.
 */
export function resolveWatchmodeKeyEntries(
  entries: readonly WatchmodeKeyEntry[],
  existing: readonly string[]
): string[] {
  const resolved = entries.map((entry) => {
    if ("value" in entry) return entry.value;
    const key = existing[entry.keep - 1];
    if (!key) {
      throw new WatchmodeKeyEntryError(
        `Watchmode API key ${entry.keep} is no longer configured — reload Settings and try again.`
      );
    }
    return key;
  });
  return normalizeWatchmodeKeys(resolved);
}
