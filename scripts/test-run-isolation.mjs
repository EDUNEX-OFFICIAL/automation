#!/usr/bin/env node
/**
 * Verifies per-user workflow run isolation (API).
 * Usage: API_URL=http://127.0.0.1:4000 node scripts/test-run-isolation.mjs
 */
const API = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

async function login(username, password) {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.accessToken, user: data.user };
}

async function api(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(`Testing run isolation against ${API}`);

  const a = await login("1tl1", "1tl1");
  const b = await login("1sc1", "1sc1");
  assert(a.user.dealerId && a.user.dealerId === b.user.dealerId, "seed users must share dealer");

  const inFlightA = await api(a.token, "/v1/workflow-runs/in-flight");
  const inFlightB = await api(b.token, "/v1/workflow-runs/in-flight");
  console.log("in-flight TL:", inFlightA.body?.run?.id ?? null, "owner", inFlightA.body?.run?.startedByUserId);
  console.log("in-flight SC:", inFlightB.body?.run?.id ?? null, "owner", inFlightB.body?.run?.startedByUserId);

  const listA = await api(a.token, `/v1/workflow-runs?dealerId=${a.user.dealerId}`);
  const listB = await api(b.token, `/v1/workflow-runs?dealerId=${b.user.dealerId}`);
  assert(listA.status === 200 && listB.status === 200, "list runs failed");

  for (const r of listA.body) {
    assert(
      !r.startedByUserId || r.startedByUserId === a.user.id,
      `TL list contains other user run ${r.id}`,
    );
  }
  for (const r of listB.body) {
    assert(
      !r.startedByUserId || r.startedByUserId === b.user.id,
      `SC list contains other user run ${r.id}`,
    );
  }
  console.log(`TL runs in list: ${listA.body.length}, SC runs in list: ${listB.body.length}`);

  const otherRun = listA.body.find((r) => r.startedByUserId === a.user.id);
  if (otherRun && b.user.id !== a.user.id) {
    const peek = await api(b.token, `/v1/workflow-runs/${otherRun.id}`);
    assert(peek.status === 403, `SC must not read TL run (got ${peek.status})`);
    console.log(`SC blocked from TL run ${otherRun.id}: OK`);
  } else {
    console.log("No TL-owned run to cross-test (start automation as 1tl1 first)");
  }

  if (inFlightA.body?.run?.id && b.user.id !== a.user.id) {
    const cross = await api(b.token, `/v1/workflow-runs/${inFlightA.body.run.id}`);
    assert(cross.status === 403, `SC must not read TL in-flight run (got ${cross.status})`);
    console.log("SC blocked from TL in-flight run: OK");
  }

  if (inFlightA.body?.run?.id) {
    const vnc = await api(a.token, `/v1/gdms-browser-view?runId=${inFlightA.body.run.id}`);
    const vncCross = await api(b.token, `/v1/gdms-browser-view?runId=${inFlightA.body.run.id}`);
    assert(vnc.status === 200 && vnc.body?.enabled, "TL browser view");
    assert(vncCross.status === 403, `SC must not get TL browser view (got ${vncCross.status})`);
    assert(
      vnc.body.pathPrefix?.includes("-u"),
      `per-user VNC path expected, got ${vnc.body.pathPrefix}`,
    );
    console.log(`TL VNC path: ${vnc.body.pathPrefix}`);
  }

  console.log("\nAll API isolation checks passed.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
