/**
 * Pure helpers for browsing the dashboard: the search filter and the A–Z rail.
 *
 * Kept out of the component so the matching rules can be tested without a DOM —
 * they're the part that's easy to get subtly wrong (accents, punctuation,
 * multi-word queries), while the component itself is just wiring.
 */

/** Rail buckets, in the order they're shown. "#" collects everything else. */
export const OTHER_LETTER = "#";
export const RAIL_LETTERS: string[] = [
  OTHER_LETTER,
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
];

/**
 * Lowercase and strip accents, so "Pokemon" finds "Pokémon" and vice versa.
 * Both the query and what it's matched against go through this.
 */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * The rail bucket a title belongs to.
 *
 * Deliberately the *first* character rather than anything cleverer: the grids
 * are ordered by the database's `title ASC`, which doesn't strip leading
 * articles either, so "The Office" lives under T exactly where the eye finds
 * it. Digits and punctuation land in "#", which sorts first in the grid too.
 */
export function sortLetter(title: string): string {
  const first = fold(title.trim()).charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : OTHER_LETTER;
}

/** Split a raw query into the folded terms every match has to contain. */
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

export interface SearchableItem {
  title: string;
  year?: number | null;
  services?: { name: string }[];
}

/** Everything a query is matched against: the title, its year, its services. */
export function searchHaystack(item: SearchableItem): string {
  const parts = [item.title, item.year ? String(item.year) : ""];
  for (const s of item.services ?? []) parts.push(s.name);
  return fold(parts.join(" "));
}

/**
 * Every term has to match somewhere, so "netflix 2019" narrows rather than
 * widens — a word-by-word AND is what people expect from a filter box.
 */
export function matchesSearch(item: SearchableItem, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = searchHaystack(item);
  return terms.every((t) => haystack.includes(t));
}

/**
 * Index of the first item in each rail bucket, so the rail can jump to it and
 * the grid knows which cards to tag as anchors.
 *
 * Built from the list in the order it is rendered (already filtered), which is
 * what keeps a jump landing on the first card you can actually see under that
 * letter rather than on one the search has hidden.
 */
export function letterAnchors(items: { title: string }[]): Map<string, number> {
  const first = new Map<string, number>();
  items.forEach((item, i) => {
    const letter = sortLetter(item.title);
    if (!first.has(letter)) first.set(letter, i);
  });
  return first;
}

/**
 * How much of the page each letter's titles take up, keyed by letter.
 *
 * `anchors` is the first card of each bucket in render order with its vertical
 * offset; `end` is the bottom of the grid. A bucket spans the distance to the
 * next one, so a letter filling a third of the section measures a third of the
 * section — which is what lets a rail sized by these weights track the
 * scrollbar instead of giving 27 letters 27 equal slices.
 *
 * Measured rather than counted: with a wrapping grid, four titles and six
 * titles can occupy the same single row, and a card's height varies with how
 * far its title wraps. Pixels already know all of that.
 */
export function letterSpans(
  anchors: { letter: string; top: number }[],
  end: number
): Map<string, number> {
  const spans = new Map<string, number>();
  anchors.forEach((a, i) => {
    const next = i + 1 < anchors.length ? anchors[i + 1].top : end;
    // Never zero or negative: these become flex-grow, and a bucket that
    // measured nothing (an unlaid-out grid, say) should still get a sliver.
    spans.set(a.letter, Math.max(next - a.top, 1));
  });
  return spans;
}
