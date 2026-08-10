import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { makeCsvToCopyTransform } from "./titlemap";

/**
 * The CSV -> COPY rewrite, driven the way the import drives it.
 *
 * These rules only fail loudly if they are wrong in the right way: a mis-escaped
 * tab or backslash produces a *valid-looking* COPY row with the columns shifted,
 * which lands in the database as a silently wrong title id mapping. Watchmode's
 * dataset is full of titles with commas and quotes, so this is exercised on
 * every import.
 */
async function run(csv: string, chunkSize = csv.length): Promise<string> {
  // Feeding it in slices proves the transform's leftover handling: the real
  // stream arrives in network-sized chunks that split rows mid-line.
  const chunks: string[] = [];
  for (let i = 0; i < csv.length; i += chunkSize) chunks.push(csv.slice(i, i + chunkSize));
  const out: Buffer[] = [];
  const transform = makeCsvToCopyTransform();
  Readable.from(chunks.length ? chunks : [""]).pipe(transform);
  for await (const c of transform) out.push(Buffer.from(c));
  return Buffer.concat(out).toString("utf8");
}

const HEADER = "Watchmode ID,IMDB ID,TMDB ID,TMDB Type,Title,Year\n";

/** Split a COPY text-format row into its columns. */
function cols(row: string): string[] {
  return row.split("\t");
}

describe("makeCsvToCopyTransform", () => {
  it("drops the header and emits one tab-separated row per title", async () => {
    const out = await run(`${HEADER}1234,tt0903747,1396,tv,Breaking Bad,2008\n`);
    expect(out).toBe("1234\ttt0903747\t1396\ttv\tBreaking Bad\t2008\n");
  });

  it("unwraps quoted fields, keeping the commas inside them", async () => {
    const out = await run(`${HEADER}1,tt1,2,movie,"Good, the Bad and the Ugly",1966\n`);
    expect(cols(out.trimEnd())[4]).toBe("Good, the Bad and the Ugly");
  });

  it("unescapes doubled quotes", async () => {
    const out = await run(`${HEADER}1,tt1,2,movie,"The ""Burbs",1989\n`);
    expect(cols(out.trimEnd())[4]).toBe('The "Burbs');
  });

  it("writes empty fields as COPY's NULL sentinel", async () => {
    const out = await run(`${HEADER}1,,,,Untitled,\n`);
    expect(cols(out.trimEnd())).toEqual(["1", "\\N", "\\N", "\\N", "Untitled", "\\N"]);
  });

  // The one that matters most: an unescaped tab in a title would shift every
  // column after it by one, silently.
  it("escapes tabs, newlines and backslashes in a title", async () => {
    const out = await run(`${HEADER}1,tt1,2,movie,"A\tB\\C",2000\n`);
    const title = cols(out.trimEnd())[4];
    expect(title).toBe("A\\tB\\\\C");
    // Still exactly six columns, which is the property the escaping protects.
    expect(cols(out.trimEnd())).toHaveLength(6);
  });

  it("skips rows without a numeric Watchmode id", async () => {
    const out = await run(
      `${HEADER}notanid,tt1,2,movie,Bad Row,2000\n7,tt2,3,movie,Good Row,2001\n`
    );
    expect(out).toBe("7\ttt2\t3\tmovie\tGood Row\t2001\n");
  });

  it("nulls a non-numeric TMDB id and year rather than passing them through", async () => {
    const out = await run(`${HEADER}1,tt1,n/a,movie,Odd,unknown\n`);
    expect(cols(out.trimEnd())).toEqual(["1", "tt1", "\\N", "movie", "Odd", "\\N"]);
  });

  it("tolerates CRLF line endings", async () => {
    const out = await run(`Watchmode ID,IMDB ID\r\n1,tt1,2,movie,Title,2000\r\n`);
    expect(out).toBe("1\ttt1\t2\tmovie\tTitle\t2000\n");
  });

  it("emits a final row that arrived without a trailing newline", async () => {
    const out = await run(`${HEADER}1,tt1,2,movie,Last,2000`);
    expect(out).toBe("1\ttt1\t2\tmovie\tLast\t2000\n");
  });

  it("reassembles rows split across chunk boundaries", async () => {
    const csv = `${HEADER}1,tt1,2,movie,"Split, Title",2000\n3,tt3,4,tv,Second,2001\n`;
    // One byte at a time is the harshest version of what the network does.
    expect(await run(csv, 1)).toBe(await run(csv));
    expect(await run(csv, 1)).toBe(
      "1\ttt1\t2\tmovie\tSplit, Title\t2000\n3\ttt3\t4\ttv\tSecond\t2001\n"
    );
  });

  it("emits nothing for a header-only file", async () => {
    expect(await run(HEADER)).toBe("");
  });
});
