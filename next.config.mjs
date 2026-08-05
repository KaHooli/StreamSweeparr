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
    // The Title ID map importer is Node-only (uses pg + node streams), and the
    // sweep scheduler reaches it through the sweep engine. The instrumentation
    // hook is also compiled for the edge runtime, which pulls both into the edge
    // graph. Stub them out there so the edge bundle never tries to resolve pg /
    // node:stream.
    if (nextRuntime === "edge") {
      for (const name of ["titlemap", "scheduler"]) {
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
