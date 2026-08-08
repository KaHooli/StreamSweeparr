import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WatchmodeClient } from "@/lib/watchmode";
import { getSettings } from "@/lib/db";
import {
  watchmodeKeyEntriesSchema,
  resolveWatchmodeKeyEntries,
  normalizeWatchmodeKeys,
  WatchmodeKeyEntryError,
} from "@/lib/watchmodeKeys";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // Legacy single-key form.
  apiKey: z.string().optional(),
  // The key ring being edited: new values, plus references to stored keys the
  // user did not retype. Same shape the settings PATCH takes.
  apiKeys: watchmodeKeyEntriesSchema.optional(),
});

export interface WatchmodeKeyTestResult {
  /** 1-based position in the ring — what the Settings card labels the field. */
  number: number;
  ok: boolean;
  quota?: number;
  quotaUsed?: number;
  error?: string;
}

/**
 * Verify Watchmode API keys (from the body, else the saved ring) and report
 * each one's quota.
 *
 * Every key is checked, not just the first: the point of a ring is to know
 * which keys still have credit and which are spent, and the /status endpoint
 * costs nothing against the quota.
 */
export const POST = withGuard(requireAdmin, async (_session, req: NextRequest) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  let keys: string[];
  if (body.apiKeys) {
    const s = await getSettings();
    try {
      keys = resolveWatchmodeKeyEntries(body.apiKeys, s.watchmodeApiKeys);
    } catch (e) {
      if (e instanceof WatchmodeKeyEntryError) {
        return NextResponse.json({ error: e.message }, { status: 409 });
      }
      throw e;
    }
  } else if (body.apiKey) {
    keys = normalizeWatchmodeKeys([body.apiKey]);
  } else {
    const s = await getSettings();
    keys = s.watchmodeApiKeys;
  }

  if (!keys.length) return NextResponse.json({ error: "No API key provided." }, { status: 400 });

  const results: WatchmodeKeyTestResult[] = [];
  for (const [i, key] of keys.entries()) {
    try {
      // One client per key: each reports on itself rather than failing over.
      const status = await new WatchmodeClient(key).status();
      results.push({ number: i + 1, ok: true, ...status });
    } catch (e) {
      results.push({ number: i + 1, ok: false, error: (e as Error).message });
    }
  }

  // A ring is usable while any key answers, so `ok` is "at least one works".
  // The top-level quota fields describe the first working key, keeping the
  // response shape compatible with the single-key callers that came before.
  const first = results.find((r) => r.ok);
  const ok = !!first;
  return NextResponse.json(
    {
      ok,
      keys: results,
      quota: first?.quota,
      quotaUsed: first?.quotaUsed,
      error: ok ? undefined : results[0]?.error,
    },
    { status: ok ? 200 : 502 }
  );
});
