const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickMimeType(): string {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/** Records the mirrored screen plus the tablet audio into a downloadable file. */
export class SessionRecorder {
  #recorder: MediaRecorder;
  #chunks: Blob[] = [];
  #ownedTracks: MediaStreamTrack[];
  readonly startedAt = Date.now();

  /** USB mode: the picture lives in a canvas, the sound in the PCM player. */
  static fromCanvas(canvas: HTMLCanvasElement, audio: MediaStream | null): SessionRecorder {
    const stream = canvas.captureStream(30);
    audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    return new SessionRecorder(stream, stream.getVideoTracks());
  }

  /**
   * @param ownedTracks Tracks created just for this recording, stopped when it
   * ends. Tracks owned by the player/peer connection must not be stopped.
   */
  constructor(stream: MediaStream, ownedTracks: MediaStreamTrack[] = []) {
    this.#ownedTracks = ownedTracks;
    const mimeType = pickMimeType();
    this.#recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 128_000,
    });
    this.#recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.#chunks.push(e.data);
    };
    this.#recorder.start(1000);
  }

  stop(): Promise<{ blob: Blob; extension: string }> {
    return new Promise((resolve) => {
      this.#recorder.onstop = () => {
        this.#ownedTracks.forEach((t) => t.stop());
        const type = this.#recorder.mimeType || "video/webm";
        resolve({
          blob: new Blob(this.#chunks, { type }),
          extension: type.startsWith("video/mp4") ? "mp4" : "webm",
        });
      };
      this.#recorder.stop();
    });
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function recordingFilename(extension: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `castkelas-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${extension}`;
}
