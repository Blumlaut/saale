import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.178.109", "**.chat.blumlaut.me"],
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
    // The watcher tick runs codemode scripts directly (not through the agent
    // loop), so this package must stay unbundled too: its sandbox resolves the
    // QuickJS worker and wasm relative to its own module URL.
    "@earendil-works/pi-codemode",
    "quickjs-wasi",
    // MCP client used for the settings connection test.
    "@earendil-works/pi-mcp",
    // Native bindings for image processing
    "sharp",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
    // A request body the middleware sees is buffered up to this and silently
    // truncated past it, which a multipart parser reports as a parse failure.
    // Uploads are chunked (8MB slices) so nothing legitimate comes near this;
    // raise it only alongside MAX_UPLOAD_CHUNK_BYTES.
    proxyClientMaxBodySize: "16mb",
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
