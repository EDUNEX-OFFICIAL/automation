/** @type {import('next').NextConfig} */
const apiUpstream = process.env.API_UPSTREAM_URL ?? "http://127.0.0.1:4000";

const nextConfig = {
  transpilePackages: ["@gdms/shared"],
  async rewrites() {
    const base = apiUpstream.replace(/\/$/, "");
    return [{ source: "/api-upstream/:path*", destination: `${base}/:path*` }];
  },
};

export default nextConfig;
