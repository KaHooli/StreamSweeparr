import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * ESLint flat config.
 *
 * Next 16 removed `next lint`, and ESLint 9 defaults to flat config, so the
 * lint step is now the ESLint CLI reading this file. `eslint-config-next`
 * exports a flat-config array directly, which is spread in below.
 */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/**",
      // The Prisma client. Generated, gitignored, and carrying its own
      // `eslint-disable` header — which this repo's config then reports as an
      // unused directive, so linting it produces nothing but noise about code
      // nobody can edit.
      "src/generated/**",
      "next-env.d.ts",
      "prisma/migrations/**",
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // Background work logs through lib/logger, which owns the only
      // sanctioned console calls (plus one documented edge-runtime exception).
      "no-console": "error",
    },
  },
  {
    // Repo maintenance scripts are command-line tools whose entire output is
    // stdout/stderr, and they run before `npm ci` has installed anything — so
    // routing them through the app's logger is neither possible nor wanted.
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
    },
  },
];

export default config;
