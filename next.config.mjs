/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Watchmode / TMDB poster & logo hosts. Using unoptimized to avoid needing
    // a full allowlist of every CDN Watchmode may reference.
    unoptimized: true,
  },
  // Node-only packages that must not be bundled into the server build.
  // (`experimental.serverComponentsExternalPackages` in Next 14.)
  serverExternalPackages: ["@prisma/client", "pg", "pg-copy-streams"],
};

export default nextConfig;
