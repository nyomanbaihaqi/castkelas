/** Fallback download link for the companion app when APK_URL isn't configured. */
export const DEFAULT_APK_URL = "https://github.com/nyomanbaihaqi/castkelas/releases/latest/download/castkelas.apk";
export const ANDROID_PACKAGE = "id.castkelas.app";

const FALLBACK_ICE: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export interface WirelessConfig {
  supabaseUrl: string;
  supabaseKey: string;
  iceServers: RTCIceServer[];
  apkUrl: string;
}

/**
 * Loads signaling + ICE config from the Vercel function `/api/config` (the
 * same endpoint the Android app uses). Falls back to VITE_* env vars so the
 * QR mode also works with `npm run dev`.
 */
export async function loadWirelessConfig(): Promise<WirelessConfig | null> {
  let remote: Partial<WirelessConfig> = {};
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (res.ok && res.headers.get("content-type")?.includes("json")) remote = await res.json();
  } catch {
    // Offline or no serverless functions (local dev).
  }

  const supabaseUrl = remote.supabaseUrl || import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = remote.supabaseKey || import.meta.env.VITE_SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  return {
    supabaseUrl,
    supabaseKey,
    iceServers: remote.iceServers?.length ? remote.iceServers : FALLBACK_ICE,
    apkUrl: remote.apkUrl || import.meta.env.VITE_APK_URL || DEFAULT_APK_URL,
  };
}
