import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.178.109"],
  output: "standalone",
  serverExternalPackages: [
    "@better-auth/kysely-adapter",
    // Native bindings — Turbopack cannot bundle non-ESM assets
    "wreq-js",
    "ssh2",
    // Exclude Pi packages from bundling — they use dynamic import() for node:
    // builtins (fs, os, path) which the bundler cannot statically analyze.
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    // MCP client used for the settings connection test.
    "@earendil-works/pi-mcp",
    // Native bindings for image processing
    "sharp",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
