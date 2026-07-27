import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The marketing + docs site builds to a fully static export (`output: "export"`
 * → ./out) so it can be hosted anywhere (Vercel, Cloudflare Pages, GitHub Pages,
 * an S3 bucket) with no Node server at runtime. All content is compiled from MDX
 * at build time; search runs client-side over a prebuilt static index.
 */
const nextConfig: NextConfig = {
  // Static export is a *deploy* concern (no-server hosting). `next dev` runs as a
  // normal Node server; `next build` (NODE_ENV=production, incl. CI/Vercel)
  // exports to ./out.
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  images: { unoptimized: true },
  devIndicators: false,
  // Trailing slashes keep the static export's directory-per-route URLs stable
  // across hosts (`/docs/foo/` → `docs/foo/index.html`).
  trailingSlash: true,
  // Pin the workspace root to this app — the repo root also carries a bun.lock
  // (the compiler workspace), which Next would otherwise infer as the root.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
};

export default nextConfig;
