// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { useLayoutEffect } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useSyncedState } from "./useSyncedState";

/**
 * `useSyncedState` backs nine settings forms, and its contract is subtle enough
 * that "it looks like the React docs" is not sufficient evidence:
 *
 *   - a local edit must survive re-renders that do not change the saved value,
 *     or typing into any settings field would be lost on every SWR poll;
 *   - a changed saved value must win, or the form would show stale data after a
 *     save made elsewhere;
 *   - and crucially, the stale value must never reach the DOM — that is the
 *     whole reason this exists rather than the `useEffect` it replaced.
 */

afterEach(cleanup);

interface ProbeLog {
  /** Every time the component function ran, including renders React discards. */
  rendered: string[];
  /** Only values that actually reached the DOM — effects run on commit. */
  committed: string[];
}

const log = (): ProbeLog => ({ rendered: [], committed: [] });

function Probe({ external, log }: { external: string; log: ProbeLog }) {
  const [value, setValue] = useSyncedState(external);
  log.rendered.push(value);
  useLayoutEffect(() => {
    log.committed.push(value);
  });
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button onClick={() => setValue("typed")}>type</button>
      <button onClick={() => setValue((v) => v + "!")}>append</button>
    </div>
  );
}

const shown = () => screen.getByTestId("value").textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

describe("useSyncedState", () => {
  it("starts at the external value", () => {
    render(<Probe external="saved" log={log()} />);
    expect(shown()).toBe("saved");
  });

  it("keeps a local edit", () => {
    render(<Probe external="saved" log={log()} />);
    click("type");
    expect(shown()).toBe("typed");
  });

  it("supports functional updates, like any setState", () => {
    render(<Probe external="a" log={log()} />);
    click("append");
    click("append");
    expect(shown()).toBe("a!!");
  });

  it("does not clobber a local edit when the external value is unchanged", () => {
    // The realistic case: SWR revalidates every few seconds and hands back the
    // same saved value while someone is mid-edit.
    const { rerender } = render(<Probe external="saved" log={log()} />);
    click("type");
    rerender(<Probe external="saved" log={log()} />);
    rerender(<Probe external="saved" log={log()} />);
    expect(shown()).toBe("typed");
  });

  it("adopts a changed external value, discarding the local edit", () => {
    const { rerender } = render(<Probe external="saved" log={log()} />);
    click("type");
    expect(shown()).toBe("typed");

    rerender(<Probe external="saved-elsewhere" log={log()} />);
    expect(shown()).toBe("saved-elsewhere");
  });

  it("never commits the stale value when the external value changes", () => {
    // This is the whole reason the hook exists. React re-invokes the component
    // when state is adjusted during render, so the function body does run once
    // with the stale value — but that render is discarded, never committed.
    // The `useEffect` version this replaced would have committed it, producing
    // a visible frame of stale data.
    const l = log();
    const { rerender } = render(<Probe external="saved" log={l} />);
    l.rendered.length = 0;
    l.committed.length = 0;

    rerender(<Probe external="fresh" log={l} />);

    expect(shown()).toBe("fresh");
    // Nothing stale reached the DOM...
    expect(l.committed).toEqual(["fresh"]);
    // ...even though the discarded render did evaluate it.
    expect(l.rendered).toEqual(["saved", "fresh"]);
  });

  it("commits exactly once per external change", () => {
    // A cheap regression guard on the "no second pass" claim: were the hook
    // ever rewritten back to an effect, this would see two commits.
    const l = log();
    const { rerender } = render(<Probe external="one" log={l} />);
    l.committed.length = 0;

    rerender(<Probe external="two" log={l} />);
    expect(l.committed).toEqual(["two"]);
  });

  it("tracks a sequence of external changes", () => {
    const { rerender } = render(<Probe external="one" log={log()} />);
    for (const next of ["two", "three", "four"]) {
      rerender(<Probe external={next} log={log()} />);
      expect(shown()).toBe(next);
    }
  });

  it("lets a local edit stand again after an external change", () => {
    const { rerender } = render(<Probe external="one" log={log()} />);
    rerender(<Probe external="two" log={log()} />);
    click("type");
    expect(shown()).toBe("typed");
    rerender(<Probe external="two" log={log()} />);
    expect(shown()).toBe("typed");
  });
});

/* Identity semantics — the documented caveat, and the reason the settings
 * cards pass `settings.countries` straight through rather than mapping it. */

function ListProbe({ external }: { external: string[] }) {
  const [value, setValue] = useSyncedState(external);
  return (
    <div>
      <span data-testid="value">{value.join(",")}</span>
      <button onClick={() => setValue(["local"])}>edit</button>
    </div>
  );
}

describe("useSyncedState — reference types", () => {
  it("keeps a local edit while the same array instance is passed back", () => {
    const stable = ["US", "GB"];
    const { rerender } = render(<ListProbe external={stable} />);
    act(() => screen.getByText("edit").click());
    rerender(<ListProbe external={stable} />);
    expect(shown()).toBe("local");
  });

  it("resyncs on a new array instance even with identical contents", () => {
    // Identity, not deep equality — the same rule a useEffect dependency array
    // would apply. Callers must pass a stable reference or a primitive.
    const { rerender } = render(<ListProbe external={["US", "GB"]} />);
    act(() => screen.getByText("edit").click());
    expect(shown()).toBe("local");

    rerender(<ListProbe external={["US", "GB"]} />);
    expect(shown()).toBe("US,GB");
  });
});
