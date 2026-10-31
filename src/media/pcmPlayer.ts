const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2; // s16le stereo
/** Delay buffered ahead of playback to absorb jitter. */
const TARGET_LATENCY = 0.06;
/** If we are this far ahead (device clock drift), drop audio to resync. */
const MAX_LATENCY = 0.3;

/**
 * Plays the raw PCM (s16le, 48kHz, stereo) stream scrcpy sends, and exposes
 * the same audio as a MediaStream so recordings include sound.
 */
export class PcmPlayer {
  readonly context: AudioContext;
  #output: GainNode;
  #mix: GainNode;
  #recordDestination: MediaStreamAudioDestinationNode;
  #nextTime = 0;
  #leftover: Uint8Array | null = null;

  constructor() {
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    this.#mix = this.context.createGain();
    this.#output = this.context.createGain();
    this.#recordDestination = this.context.createMediaStreamDestination();
    this.#mix.connect(this.#output).connect(this.context.destination);
    this.#mix.connect(this.#recordDestination);
  }

  get recordStream(): MediaStream {
    return this.#recordDestination.stream;
  }

  /** Must be called from a user gesture before audio can play. */
  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  /** Volume of the laptop speakers only; recordings are unaffected. */
  setVolume(volume: number): void {
    this.#output.gain.value = volume;
  }

  reset(): void {
    this.#nextTime = 0;
    this.#leftover = null;
  }

  feed(chunk: Uint8Array): void {
    let bytes = chunk;
    if (this.#leftover) {
      bytes = new Uint8Array(this.#leftover.length + chunk.length);
      bytes.set(this.#leftover);
      bytes.set(chunk, this.#leftover.length);
      this.#leftover = null;
    }

    const frames = Math.floor(bytes.length / BYTES_PER_FRAME);
    const used = frames * BYTES_PER_FRAME;
    if (used < bytes.length) this.#leftover = bytes.slice(used);
    if (frames === 0) return;

    const now = this.context.currentTime;
    if (this.#nextTime < now + 0.01) {
      this.#nextTime = now + TARGET_LATENCY;
    } else if (this.#nextTime > now + MAX_LATENCY) {
      // Device clock runs faster than ours: skip this chunk to catch up.
      return;
    }

    const buffer = this.context.createBuffer(CHANNELS, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const view = new DataView(bytes.buffer, bytes.byteOffset, used);
    for (let i = 0; i < frames; i++) {
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#mix);
    source.start(this.#nextTime);
    this.#nextTime += buffer.duration;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
