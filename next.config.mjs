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
  /**
   * Response headers that hold for every route.
   *
   * All of these are defence in depth — nothing here is the only thing standing
   * between an attacker and the app — but the buttons on this UI unmonitor and
   * delete media, so the cost of a browser being talked into rendering or
   * framing it wrongly is unusually high for a small app.
   *
   *  - **Framing.** `frame-ancestors` is the modern control and `X-Frame-Options`
   *    is what older browsers read; both are sent because they are read by
   *    different code paths, not because either is redundant. Session cookies
   *    are `SameSite=Lax` and so are not sent to a cross-site frame anyway —
   *    this is the second lock, for the deployments that weaken the first
   *    (`AUTH_COOKIE_INSECURE` over plain HTTP, an origin shared with something
   *    else).
   *  - **`nosniff`.** The API answers JSON and the app renders none of it as
   *    markup, but content sniffing is decided by the browser, not by us.
   *  - **`Referrer-Policy`.** Poster images and provider deep links point at
   *    third parties; there is no reason for them to learn which page of this
   *    app the user was on. The origin is enough for a CDN's hotlink check,
   *    which is why this is not `no-referrer`.
   *
   * Deliberately *not* here: HSTS. It is a promise about a whole origin and it
   * is not this app's to make — self-hosted installs legitimately run over plain
   * HTTP on a LAN, and a stray `Strict-Transport-Security` would strand one that
   * later moves back off TLS. That belongs on the reverse proxy terminating it.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
