import type { NextConfig } from "next";

const backendUrl = (process.env.BACKEND_INTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  experimental: {
    // Recommendation generation can take up to 45s plus database processing.
    // The default 30s rewrite proxy timeout caused ECONNRESET / HTTP 500.
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
