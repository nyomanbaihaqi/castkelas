export type QualityId = "hemat" | "seimbang" | "tajam";

export interface QualityPreset {
  id: QualityId;
  label: string;
  hint: string;
  /** Longest side in pixels, 0 = native resolution. */
  maxSize: number;
  videoBitRate: number;
  maxFps: number;
  /** Lower targets for QR mode: WiFi has far less headroom than USB. */
  wireless: { maxSize: number; bitrate: number; fps: number };
}

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: "hemat",
    label: "Hemat",
    hint: "1024px · 30fps · paling ringan untuk laptop lama",
    maxSize: 1024,
    videoBitRate: 2_000_000,
    maxFps: 30,
    wireless: { maxSize: 1024, bitrate: 1_500_000, fps: 30 },
  },
  {
    id: "seimbang",
    label: "Seimbang",
    hint: "1600px · 60fps · rekomendasi untuk mengajar",
    maxSize: 1600,
    videoBitRate: 6_000_000,
    maxFps: 60,
    wireless: { maxSize: 1600, bitrate: 4_000_000, fps: 30 },
  },
  {
    id: "tajam",
    label: "Tajam",
    hint: "Resolusi asli · 60fps · teks paling jelas",
    maxSize: 0,
    videoBitRate: 12_000_000,
    maxFps: 60,
    wireless: { maxSize: 1920, bitrate: 8_000_000, fps: 60 },
  },
];

export const DEFAULT_QUALITY: QualityId = "seimbang";

export function getPreset(id: QualityId): QualityPreset {
  return QUALITY_PRESETS.find((p) => p.id === id) ?? QUALITY_PRESETS[1];
}
