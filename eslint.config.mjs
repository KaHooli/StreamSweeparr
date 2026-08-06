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
];

export default config;
