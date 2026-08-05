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
    // Enables src/instrumentation.ts (the 12h Title ID map refresh and the
    // scheduled-sweep timer).
    instrumentationHook: true,
  },
  webpack: (config, { nextRuntime, webpack }) => {
    // Several lib modules are Node-only: the Title ID map importer (pg + node
    // streams), the sweep scheduler that reaches it through the sweep engine,
    // and the credential encryption (node:crypto). The instrumentation hook is
    // also compiled for the edge runtime, which pulls all of them into the edge
    // graph. Stub them out there so the edge bundle never tries to resolve pg /
    // node:stream / node:crypto.
    if (nextRuntime === "edge") {
      for (const name of ["titlemap", "scheduler", "secrets"]) {
        const pattern = new RegExp(`lib[\\\\/]${name}(\\.ts)?$`);
        config.plugins.push(
          new webpack.NormalModuleReplacementPlugin(pattern, (resource) => {
            resource.request = resource.request.replace(
              new RegExp(`${name}(\\.ts)?$`),
              `${name}.edge-stub`
            );
          })
        );
      }
    }
    return config;
  },
};

export default nextConfig;
