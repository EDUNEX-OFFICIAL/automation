/** @type {import('next').NextConfig} */
const apiUpstream = process.env.API_UPSTREAM_URL ?? "http://127.0.0.1:4000";
const gdmsPlaywrightHost =
  process.env.GDMS_PLAYWRIGHT_HOST ?? process.env.GDMS_BROWSER_UPSTREAM_URL?.replace(/:\d+$/, "")?.replace(/\/$/, "") ?? "http://automation";

const USER_VNC_SLOTS = 16;
const ENQUIRY_WS_BASE = 6082;
const FOLLOW_UP_WS_BASE = 6098;

function userVncRewrites() {
  const host = gdmsPlaywrightHost.replace(/\/$/, "");
  const rules = [];
  for (let slot = 0; slot < USER_VNC_SLOTS; slot++) {
    rules.push({
      source: `/gdms-browser-enq-u${slot}/:path*`,
      destination: `${host}:${ENQUIRY_WS_BASE + slot}/:path*`,
    });
    rules.push({
      source: `/gdms-browser-fup-u${slot}/:path*`,
      destination: `${host}:${FOLLOW_UP_WS_BASE + slot}/:path*`,
    });
    // Lost Inquiry shares FUP websockify ports (separate browser profile, same slot).
    rules.push({
      source: `/gdms-browser-lost-u${slot}/:path*`,
      destination: `${host}:${FOLLOW_UP_WS_BASE + slot}/:path*`,
    });
  }
  return rules;
}

const nextConfig = {
  transpilePackages: ["@gdms/shared"],
  async rewrites() {
    const base = apiUpstream.replace(/\/$/, "");
    return [
      { source: "/api-upstream/socket.io", destination: `${base}/socket.io/` },
      { source: "/api-upstream/socket.io/:path*", destination: `${base}/socket.io/:path*` },
      { source: "/api-upstream/:path*", destination: `${base}/:path*` },
      ...userVncRewrites(),
    ];
  },
};

export default nextConfig;
