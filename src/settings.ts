import { DEFAULT_QUALITY, type QualityId } from "./quality";

export interface UserSettings {
  quality: QualityId;
  audioOnTablet: boolean;
  volume: number;
}

const KEY = "castkelas.settings";
const DEFAULTS: UserSettings = { quality: DEFAULT_QUALITY, audioOnTablet: false, volume: 1 };

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: settings just won't persist.
  }
}
