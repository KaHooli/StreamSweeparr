/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Watchmode / TMDB poster & logo hosts. Using unoptimized to avoid needing
    // a full allowlist of every CDN Watchmode may reference.
    unoptimized: true,
  },
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "pg", "pg-copy-streams"],
    // Enables src/instrumentation.ts (the 12h Title ID map scheduler).
    instrumentationHook: true,
  },
  webpack: (config, { nextRuntime, webpack }) => {
    // The Title ID map importer is Node-only (uses pg + node streams). The
    // instrumentation hook is also compiled for the edge runtime, which pulls
    // titlemap.ts into the edge graph. Stub it out there so the edge bundle
    // never tries to resolve pg / node:stream.
    if (nextRuntime === "edge") {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /lib[\\/]titlemap(\.ts)?$/,
          (resource) => {
            resource.request = resource.request.replace(
              /titlemap(\.ts)?$/,
              "titlemap.edge-stub"
            );
          }
        )
      );
    }
    return config;
  },
};

export default nextConfig;
