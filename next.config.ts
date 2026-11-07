import type { NextConfig } from "next";

const backendUrl = (process.env.BACKEND_INTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
