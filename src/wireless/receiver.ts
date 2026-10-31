import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { QualityPreset } from "../quality";
import type { WirelessConfig } from "./config";
import {
  SIGNAL_EVENT,
  channelName,
  randomId,
  tuneOpus,
  type ControlFromTablet,
  type LaptopMessage,
  type TabletMessage,
} from "./protocol";

/** Extra jitter buffer: trades ~0.1s latency for smoother playback on busy WiFi. */
const JITTER_BUFFER_MS = 120;

export type WirelessStatus = "waiting" | "connecting" | "streaming" | "reconnecting";

export interface WirelessEvents {
  onStatus(status: WirelessStatus, message?: string): void;
  onStream(stream: MediaStream): void;
  onDevice(name: string): void;
  onAudio(state: "on" | "unavailable"): void;
}

export interface WirelessStats {
  fps: number;
  width: number;
  height: number;
  /** Relayed through TURN (e.g. WiFi with client isolation) instead of direct. */
  relayed: boolean;
}

/**
 * Laptop side of QR mode: waits on a secret Supabase Realtime channel for a
 * tablet to say hello, then receives its screen + audio over WebRTC.
 */
export class WirelessReceiver {
  readonly channelId = randomId(20);
  #config: WirelessConfig;
  #events: WirelessEvents;
  #client: SupabaseClient;
  #channel: RealtimeChannel | undefined;
  #pc: RTCPeerConnection | undefined;
  #control: RTCDataChannel | undefined;
  #senderId: string | undefined;
  #pendingIce: RTCIceCandidateInit[] = [];
  #quality: QualityPreset;
  #closed = false;

  constructor(config: WirelessConfig, quality: QualityPreset, events: WirelessEvents) {
    this.#config = config;
    this.#quality = quality;
    this.#events = events;
    this.#client = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** What the QR code encodes. Opens the join page or the app directly. */
  get joinUrl(): string {
    return `${location.origin}/join?c=${this.channelId}`;
  }

  async start(): Promise<void> {
    const channel = this.#client.channel(channelName(this.channelId), {
      config: { broadcast: { self: false, ack: false } },
    });
    this.#channel = channel;
    channel.on("broadcast", { event: SIGNAL_EVENT }, ({ payload }) => {
      void this.#onSignal(payload as TabletMessage).catch((e) => console.error("[wireless]", e));
    });

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve();
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(new Error(`Gagal terhubung ke server sinyal (${err?.message ?? status}). Cek internet laptop.`));
        }
      });
    });
    this.#events.onStatus("waiting");
  }

  setQuality(quality: QualityPreset): void {
    this.#quality = quality;
    this.#sendQuality();
  }

  async getStats(): Promise<WirelessStats | null> {
    const pc = this.#pc;
    if (!pc) return null;
    const report = await pc.getStats();
    let fps = 0;
    let width = 0;
    let height = 0;
    let relayed = false;
    let selectedPair: string | undefined;
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") {
        fps = Math.round(s.framesPerSecond ?? 0);
        width = s.frameWidth ?? 0;
        height = s.frameHeight ?? 0;
      }
      if (s.type === "transport" && s.selectedCandidatePairId) selectedPair = s.selectedCandidatePairId;
    });
    if (selectedPair) {
      const pair = report.get(selectedPair);
      const local = pair && report.get(pair.localCandidateId);
      const remote = pair && report.get(pair.remoteCandidateId);
      relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
    }
    return { fps, width, height, relayed };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#senderId) await this.#send({ type: "bye", to: this.#senderId }).catch(() => {});
    this.#teardownPeer();
    if (this.#channel) await this.#client.removeChannel(this.#channel);
  }

  #send(message: LaptopMessage) {
    return this.#channel!.send({
      type: "broadcast",
      event: SIGNAL_EVENT,
      payload: { from: "laptop", ...message },
    });
  }

  async #onSignal(message: TabletMessage): Promise<void> {
    if (this.#closed || message.from !== "tablet") return;

    switch (message.type) {
      case "hello": {
        const busy =
          this.#senderId !== undefined &&
          this.#senderId !== message.id &&
          this.#pc?.connectionState === "connected";
        if (busy) {
          await this.#send({ type: "busy", to: message.id });
          return;
        }
        if (this.#senderId !== message.id) this.#teardownPeer();
        this.#senderId = message.id;
        if (message.device) this.#events.onDevice(message.device);
        await this.#send({ type: "welcome", to: message.id });
        if (!this.#pc) this.#events.onStatus("connecting");
        return;
      }
      case "offer":
        if (message.id === this.#senderId) await this.#acceptOffer(message.sdp);
        return;
      case "ice": {
        if (message.id !== this.#senderId) return;
        const candidate = { candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex };
        if (this.#pc?.remoteDescription) await this.#pc.addIceCandidate(candidate);
        else this.#pendingIce.push(candidate);
        return;
      }
      case "bye":
        if (message.id !== this.#senderId) return;
        this.#teardownPeer();
        this.#senderId = undefined;
        this.#events.onStatus("waiting", "Tablet berhenti cast. Scan QR lagi untuk menyambung.");
        return;
    }
  }

  async #acceptOffer(sdp: string): Promise<void> {
    this.#teardownPeer();
    const senderId = this.#senderId!;
    const pc = new RTCPeerConnection({ iceServers: this.#config.iceServers });
    this.#pc = pc;
    const stream = new MediaStream();

    pc.ontrack = (e) => {
      try {
        (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = JITTER_BUFFER_MS;
      } catch {
        // Older browsers: keep the default jitter buffer.
      }
      stream.addTrack(e.track);
      this.#events.onStream(stream);
    };

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      this.#control = dc;
      dc.onopen = () => this.#sendQuality();
      dc.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as ControlFromTablet;
          if (data.type === "info") {
            if (data.device) this.#events.onDevice(data.device);
            if (data.audio) this.#events.onAudio(data.audio);
          }
        } catch {
          // Ignore malformed control messages.
        }
      };
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate || this.#pc !== pc) return;
      void this.#send({
        type: "ice",
        to: senderId,
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      });
    };

    pc.onconnectionstatechange = () => {
      if (this.#pc !== pc) return;
      switch (pc.connectionState) {
        case "connected":
          this.#events.onStatus("streaming");
          break;
        case "disconnected":
        case "failed":
          // The tablet notices too and re-sends hello/offer by itself.
          this.#events.onStatus("reconnecting", "Sinyal WiFi terganggu, menyambung ulang…");
          break;
      }
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    for (const c of this.#pendingIce.splice(0)) await pc.addIceCandidate(c);
    const answer = await pc.createAnswer();
    answer.sdp = tuneOpus(answer.sdp ?? "");
    await pc.setLocalDescription(answer);
    await this.#send({ type: "answer", to: senderId, sdp: answer.sdp });
  }

  #sendQuality(): void {
    if (this.#control?.readyState !== "open") return;
    const { maxSize, bitrate, fps } = this.#quality.wireless;
    this.#control.send(JSON.stringify({ type: "quality", maxSize, bitrate, fps }));
  }

  #teardownPeer(): void {
    this.#control?.close();
    this.#control = undefined;
    this.#pc?.close();
    this.#pc = undefined;
    this.#pendingIce = [];
  }
}
