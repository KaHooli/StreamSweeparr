import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Watchmode / TMDB poster & logo hosts. Using unoptimized to avoid needing
    // a full allowlist of every CDN Watchmode may reference.
    unoptimized: true,
  },
  // Build stamps for Settings → Info. Inlined here so the running app reports
  // what it was *built* from: the image has no git history, and reading
  // package.json at runtime would only work for some deployment layouts.
  // APP_COMMIT / APP_BUILT_AT come from Docker build args (see Dockerfile) and
  // are simply empty for a local `npm run build`.
  env: {
    APP_VERSION: pkg.version ?? "",
    APP_NEXT_VERSION: pkg.dependencies?.next ?? "",
    APP_COMMIT: process.env.APP_COMMIT ?? "",
    APP_BUILT_AT: process.env.APP_BUILT_AT ?? "",
  },
  // Node-only packages that must not be bundled into the server build.
  // (`experimental.serverComponentsExternalPackages` in Next 14.)
  serverExternalPackages: ["@prisma/client", "pg", "pg-copy-streams"],
};

export default nextConfig;
