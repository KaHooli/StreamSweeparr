"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Local state seeded from a value that can change underneath it.
 *
 * The settings cards each hold an editable copy of one slice of the saved
 * configuration. When SWR revalidates and the saved value changes, the copy has
 * to follow — otherwise the form shows stale data after a save elsewhere.
 *
 * The obvious spelling is `useEffect(() => setLocal(external), [external])`,
 * but that commits a render with the stale value and then immediately renders
 * again, which is why React's hooks lint rule rejects it. Adjusting state
 * *during* render instead is the documented alternative: React discards the
 * in-progress render and restarts with the new value, so nothing stale is ever
 * committed and there is no second pass.
 *
 * @see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 *
 * Comparison is by identity, matching what a `useEffect` dependency array would
 * have done: a caller passing a freshly-built array or object every render will
 * resync every render, so pass a stable reference or a primitive.
 */
export function useSyncedState<T>(external: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(external);
  const [lastExternal, setLastExternal] = useState<T>(external);

  if (!Object.is(external, lastExternal)) {
    setLastExternal(external);
    setValue(external);
  }

  return [value, setValue];
}
