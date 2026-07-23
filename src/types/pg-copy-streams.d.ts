// Minimal type declaration for pg-copy-streams (no official @types package).
declare module "pg-copy-streams" {
  import { Writable } from "node:stream";
  /** Returns a Writable stream to pipe CSV/text data into a COPY ... FROM STDIN. */
  export function from(sql: string): Writable & { query: string };
  /** Returns a Readable stream for COPY ... TO STDOUT. */
  export function to(sql: string): NodeJS.ReadableStream;
}
