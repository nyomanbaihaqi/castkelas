import type { VideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";

/**
 * Draws decoded frames onto a plain 2D canvas. A 2D canvas (unlike the
 * bitmaprenderer/WebGL renderers) can be fed straight into
 * `canvas.captureStream()`, which the session recorder relies on.
 */
export class CanvasRenderer implements VideoFrameRenderer {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D tidak didukung browser ini");
    this.#ctx = ctx;
  }

  setSize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(frame: VideoFrame): void {
    this.#ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }
}
