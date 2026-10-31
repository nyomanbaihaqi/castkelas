import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, ScrcpyAudioCodec } from "@yume-chan/scrcpy";
import { WebCodecsVideoDecoder } from "@yume-chan/scrcpy-decoder-webcodecs";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";
import { CanvasRenderer } from "../media/canvasRenderer";
import type { PcmPlayer } from "../media/pcmPlayer";
import type { QualityPreset } from "../quality";

export const SCRCPY_VERSION = "3.3.3";
const SERVER_URL = `/scrcpy-server-v${SCRCPY_VERSION}`;
const MAX_AUTO_RESTARTS = 3;

export type SessionStatus =
  | "connecting"
  | "authorizing"
  | "starting"
  | "streaming"
  | "reconnecting"
  | "disconnected";

export type AudioState = "pending" | "on" | "unavailable";

export interface SessionEvents {
  onStatus(status: SessionStatus, message?: string): void;
  onAudio(state: AudioState): void;
  onVideoSize(width: number, height: number): void;
}

export interface StreamSettings {
  quality: QualityPreset;
  /** Keep audio playing on the tablet too (Android 13+). */
  audioOnTablet: boolean;
}

export function isUsbSupported(): boolean {
  return AdbDaemonWebUsbDeviceManager.BROWSER !== undefined && WebCodecsVideoDecoder.isSupported;
}

/** Opens the browser's USB picker. Returns undefined if the user cancels. */
export async function pickUsbDevice(): Promise<AdbDaemonWebUsbDevice | undefined> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) throw new Error("Browser ini tidak mendukung WebUSB. Pakai Chrome atau Edge di laptop.");
  return manager.requestDevice();
}

/** Devices the user already granted permission to (no picker needed). */
export async function getKnownUsbDevices(): Promise<AdbDaemonWebUsbDevice[]> {
  return (await AdbDaemonWebUsbDeviceManager.BROWSER?.getDevices()) ?? [];
}

let serverBinary: Promise<Uint8Array> | undefined;
function loadServerBinary(): Promise<Uint8Array> {
  serverBinary ??= fetch(SERVER_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`Gagal memuat scrcpy-server (${r.status})`);
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b));
  serverBinary.catch(() => (serverBinary = undefined));
  return serverBinary;
}

export function describeError(e: unknown): string {
  if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
    return "Tablet lagi dipakai program lain (adb, Android Studio, atau scrcpy). Tutup program itu, atau jalankan `adb kill-server`, lalu coba lagi.";
  }
  if (e instanceof AdbScrcpyExitedError) {
    const last = e.output.filter(Boolean).slice(-3).join(" · ");
    return `Mirroring di tablet berhenti. ${last}`;
  }
  if (e instanceof DOMException && e.name === "NetworkError") {
    return "Koneksi USB terputus. Cek kabel lalu sambungkan lagi.";
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * One USB mirroring session: ADB over WebUSB → scrcpy server on the tablet →
 * H.264 video into a canvas + raw PCM audio into the laptop speakers.
 */
export class UsbMirrorSession {
  readonly renderer: CanvasRenderer;
  #player: PcmPlayer;
  #events: SessionEvents;
  #device: AdbDaemonWebUsbDevice;
  #adb: Adb | undefined;
  #client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>> | undefined;
  #decoder: WebCodecsVideoDecoder | undefined;
  #settings: StreamSettings | undefined;
  #closed = false;
  #restarting = false;
  #autoRestarts = 0;
  #onUsbConnect = (e: USBConnectionEvent) => void this.#handleReplug(e);

  constructor(device: AdbDaemonWebUsbDevice, canvas: HTMLCanvasElement, player: PcmPlayer, events: SessionEvents) {
    this.#device = device;
    this.renderer = new CanvasRenderer(canvas);
    this.#player = player;
    this.#events = events;
  }

  get deviceName(): string {
    return this.#adb?.banner.model ?? this.#device.name;
  }

  get serial(): string {
    return this.#device.serial;
  }

  get framesRendered(): number {
    return this.#decoder?.framesRendered ?? 0;
  }

  async start(settings: StreamSettings): Promise<void> {
    this.#settings = settings;
    await this.#connectAdb();
    await this.#startScrcpy();
  }

  /** Apply new quality/audio settings by restarting scrcpy (USB stays connected). */
  async applySettings(settings: StreamSettings): Promise<void> {
    this.#settings = settings;
    if (!this.#adb) return;
    this.#restarting = true;
    try {
      await this.#stopScrcpy();
      await this.#startScrcpy();
    } finally {
      this.#restarting = false;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    navigator.usb?.removeEventListener("connect", this.#onUsbConnect);
    await this.#stopScrcpy();
    await this.#adb?.close().catch(() => {});
    this.#adb = undefined;
  }

  async #connectAdb(): Promise<void> {
    this.#events.onStatus("connecting");
    const connection = await this.#device.connect();

    this.#events.onStatus("authorizing");
    const transport = await AdbDaemonTransport.authenticate({
      serial: this.#device.serial,
      connection,
      credentialStore: new AdbWebCredentialStore("CastKelas"),
    });
    const adb = new Adb(transport);
    this.#adb = adb;

    void adb.disconnected.then(() => {
      if (this.#adb !== adb || this.#closed) return;
      this.#adb = undefined;
      void this.#stopScrcpy();
      this.#events.onStatus("reconnecting", "Kabel USB terlepas. Colokkan lagi, nanti tersambung otomatis.");
      navigator.usb?.addEventListener("connect", this.#onUsbConnect);
    });
  }

  async #handleReplug(e: USBConnectionEvent): Promise<void> {
    if (this.#closed || e.device.serialNumber !== this.#device.serial) return;
    navigator.usb.removeEventListener("connect", this.#onUsbConnect);
    const [device] = (await getKnownUsbDevices()).filter((d) => d.serial === this.#device.serial);
    if (!device) return;
    this.#device = device;
    try {
      await this.#connectAdb();
      await this.#startScrcpy();
    } catch (err) {
      this.#events.onStatus("disconnected", describeError(err));
    }
  }

  async #startScrcpy(): Promise<void> {
    const adb = this.#adb;
    const settings = this.#settings;
    if (!adb || !settings) return;

    this.#events.onStatus("starting");
    this.#events.onAudio("pending");

    const binary = await loadServerBinary();
    await AdbScrcpyClient.pushServer(
      adb,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(binary);
          controller.close();
        },
      }),
    );

    const { quality } = settings;
    const options = new AdbScrcpyOptionsLatest(
      {
        video: true,
        videoCodec: "h264",
        maxSize: quality.maxSize,
        videoBitRate: quality.videoBitRate,
        maxFps: quality.maxFps,
        audio: true,
        audioCodec: "raw",
        audioDup: settings.audioOnTablet,
        control: true,
        clipboardAutosync: false,
        stayAwake: true,
        logLevel: "info",
      },
      { version: SCRCPY_VERSION },
    );

    const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
    this.#client = client;

    // Server logs must be drained or the ADB connection stalls.
    void client.output
      .pipeTo(new WritableStream<string>({ write: (line) => console.debug("[scrcpy]", line) }))
      .catch(() => {});

    const video = await client.videoStream;
    const decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec, renderer: this.renderer });
    this.#decoder = decoder;
    decoder.sizeChanged(({ width, height }) => this.#events.onVideoSize(width, height));
    void video.stream.pipeTo(decoder.writable).catch(() => {});

    void this.#startAudio(client);

    void client.exited.then(() => this.#handleUnexpectedExit(client));

    this.#autoRestarts = 0;
    this.#events.onStatus("streaming");
  }

  async #startAudio(client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>): Promise<void> {
    const metadata = await client.audioStream;
    if (!metadata || metadata.type !== "success" || metadata.codec !== ScrcpyAudioCodec.Raw) {
      this.#events.onAudio("unavailable");
      return;
    }
    this.#player.reset();
    this.#events.onAudio("on");
    await metadata.stream
      .pipeTo(
        new WritableStream({
          write: (packet) => {
            if (packet.type === "data") this.#player.feed(packet.data);
          },
        }),
      )
      .catch(() => {});
  }

  async #handleUnexpectedExit(client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>): Promise<void> {
    if (this.#client !== client || this.#closed || this.#restarting || !this.#adb) return;
    this.#client = undefined;
    this.#decoder?.dispose();
    this.#decoder = undefined;

    if (this.#autoRestarts >= MAX_AUTO_RESTARTS) {
      this.#events.onStatus("disconnected", "Mirroring berhenti berkali-kali. Coba sambungkan ulang.");
      return;
    }
    this.#autoRestarts += 1;
    this.#events.onStatus("reconnecting", "Mirroring terhenti, menyambung ulang…");
    try {
      await this.#startScrcpy();
    } catch (err) {
      this.#events.onStatus("disconnected", describeError(err));
    }
  }

  async #stopScrcpy(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#decoder?.dispose();
    this.#decoder = undefined;
    this.#player.reset();
    await client?.close().catch(() => {});
  }
}
