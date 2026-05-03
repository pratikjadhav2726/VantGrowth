import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    GROWTHOS_API_BASE_URL:
      process.env.GROWTHOS_API_BASE_URL ?? "http://localhost:3000",
  },
};

export default nextConfig;
