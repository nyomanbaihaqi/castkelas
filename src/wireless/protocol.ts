/**
 * Signaling protocol shared with the Android app (android/.../Signaling.kt).
 * Messages travel as Supabase Realtime broadcasts, event "signal", on the
 * channel "castkelas:<channelId>". The channel id is a random secret that
 * only exists in the QR code.
 *
 *   tablet → laptop  hello   { id, device }        repeated until answered
 *   laptop → tablet  welcome { to } | busy { to }
 *   tablet → laptop  offer   { id, sdp }
 *   laptop → tablet  answer  { to, sdp }
 *   both             ice     { id | to, candidate, sdpMid, sdpMLineIndex }
 *   both             bye     { id | to }
 *
 * After WebRTC connects, a data channel "control" (opened by the tablet) carries:
 *   laptop → tablet  { type: "quality", maxSize, bitrate, fps }
 *   tablet → laptop  { type: "info", device, audio: "on" | "unavailable" }
 */
export const SIGNAL_EVENT = "signal";

export function channelName(channelId: string): string {
  return `castkelas:${channelId}`;
}

export type TabletMessage =
  | { from: "tablet"; type: "hello"; id: string; device?: string }
  | { from: "tablet"; type: "offer"; id: string; sdp: string }
  | { from: "tablet"; type: "ice"; id: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { from: "tablet"; type: "bye"; id: string };

export type LaptopMessage =
  | { type: "welcome"; to: string }
  | { type: "busy"; to: string }
  | { type: "answer"; to: string; sdp: string }
  | { type: "ice"; to: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: "bye"; to: string };

export type ControlFromTablet = { type: "info"; device?: string; audio?: "on" | "unavailable" };

export function randomId(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Ask the tablet for stereo, high-bitrate Opus (music/video sound, not just voice). */
export function tuneOpus(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!match) return sdp;
  const pt = match[1];
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params: string) =>
    params.includes("stereo=1") ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`,
  );
}
