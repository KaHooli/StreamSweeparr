#!/usr/bin/env node
/**
 * Assert that every place this project names a Node version names the same one.
 *
 * There are three of them and nothing used to connect them, so they drifted:
 * CI tested Node 20 while the published image shipped Node 25 — two majors
 * apart, for months, with nothing failing to say so. Neither runtime validated
 * the other, which is the entire point of running the tests.
 *
 * `.nvmrc` is the source of truth. CI reads it directly (`node-version-file`),
 * so it cannot drift; the Dockerfile and `engines.node` can, and are checked
 * here. Runs as its own CI step before `npm ci`, so a mismatch fails in seconds
 * with a message that says which file to fix.
 *
 * Deliberately dependency-free: it has to run before `npm ci` installs anything.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const problems = [];

/** `24`, `24.19`, `v24.19.0` -> `24`. */
function major(spec) {
  const m = /^v?(\d+)/.exec(spec.trim());
  return m ? m[1] : null;
}

// --- The source of truth ----------------------------------------------------

const nvmrc = read(".nvmrc");
const expected = major(nvmrc);
if (!expected) {
  console.error(`.nvmrc does not contain a version number (found ${JSON.stringify(nvmrc)}).`);
  process.exit(1);
}

// --- The Dockerfile ---------------------------------------------------------

// Every stage must be on the same major; a build stage newer than the runner
// can produce output the runner cannot execute.
const froms = [...read("Dockerfile").matchAll(/^FROM\s+node:(\S+)/gm)];
if (froms.length === 0) {
  problems.push("Dockerfile has no `FROM node:...` line — this check can no longer see the image's Node version.");
}
for (const [line, tag] of froms.map((m) => [m[0], m[1]])) {
  const found = major(tag);
  if (found !== expected) {
    problems.push(`Dockerfile: \`${line}\` is Node ${found ?? "?"}, but .nvmrc says ${expected}.`);
  }
}

// --- package.json engines ---------------------------------------------------

const pkg = JSON.parse(read("package.json"));
const engines = pkg.engines?.node;
if (!engines) {
  problems.push("package.json has no `engines.node`; it is what makes a dependency requiring a newer Node fail loudly.");
} else if (major(engines.replace(/^[^\d]*/, "")) !== expected) {
  problems.push(`package.json: engines.node is "${engines}", but .nvmrc says ${expected}. Expected ">=${expected}".`);
}

// --- CI still reads .nvmrc --------------------------------------------------

// If someone replaces `node-version-file` with a hardcoded `node-version`, this
// script would keep passing while silently no longer covering CI.
const ci = read(".github/workflows/ci.yml");
if (!/node-version-file:\s*["']?\.nvmrc/.test(ci)) {
  problems.push(".github/workflows/ci.yml no longer sets `node-version-file: .nvmrc`, so CI's Node version is unchecked.");
}

// --- The runtime actually running this --------------------------------------

// Locally this is advice: plenty of things work fine on a nearby major. In CI
// it is an assertion that setup-node installed what .nvmrc asked for.
const running = major(process.version);
if (running !== expected) {
  const msg = `running Node ${process.version}, but this project targets ${expected} (see .nvmrc).`;
  if (process.env.CI) problems.push(`CI is ${msg}`);
  else console.warn(`Note: ${msg}`);
}

// --- Result -----------------------------------------------------------------

if (problems.length > 0) {
  console.error(`Node version mismatch (.nvmrc says ${expected}):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nUpdate every location together, or change .nvmrc and re-run.");
  process.exit(1);
}

console.log(`Node ${expected} everywhere: .nvmrc, Dockerfile (${froms.length} stages), engines.node, CI.`);
