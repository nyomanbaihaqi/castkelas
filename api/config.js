// Vercel Function: GET /api/config
// Shared by the laptop web app and the Android app. Returns the (public)
// Supabase Realtime credentials used for signaling, plus short-lived
// ICE servers. TURN credentials are minted per request from Cloudflare so the
// long-lived Cloudflare API token never leaves the server.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL                 https://<project>.supabase.co (defaults to the CastKelas project)
//   SUPABASE_PUBLISHABLE_KEY     sb_publishable_... (defaults to the CastKelas project)
//   CLOUDFLARE_TURN_KEY_ID       optional, enables TURN relay
//   CLOUDFLARE_TURN_API_TOKEN    optional, enables TURN relay
//   APK_URL                      optional, download link for the Android app

// Publishable (client-side) credentials: safe to ship, they end up in the browser anyway.
const DEFAULT_SUPABASE_URL = "https://xvzeoqiaeltrmqlogcei.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_vh5Flof2996Y8eyFBya4UA_e0fgBW4x";

const STUN_SERVERS =[{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
const TURN_TTL_SECONDS = 12 * 60 * 60;

async function cloudflareTurn() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return [];

  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
  const data = await res.json();
  const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];

  // Browsers block port 53; drop those URLs (per Cloudflare's guidance).
  return servers
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
      return { ...s, urls };
    })
    .filter((s) => s.urls.length > 0);
}

export default async function handler(req, res) {
  let turn = [];
  try {
    turn = await cloudflareTurn();
  } catch (e) {
    console.error("TURN credentials failed:", e);
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_KEY,
    iceServers: [...STUN_SERVERS, ...turn],
    apkUrl: process.env.APK_URL ?? null,
  });
}
