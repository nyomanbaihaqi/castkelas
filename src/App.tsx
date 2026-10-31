import { useCallback, useEffect, useRef, useState } from "react";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { Home } from "./components/Home";
import { PowerIcon, ProjectorIcon, RecordIcon, SpeakerIcon, StopIcon } from "./components/Icons";
import { PcmPlayer } from "./media/pcmPlayer";
import { SessionRecorder, downloadBlob, recordingFilename } from "./media/recorder";
import { QUALITY_PRESETS, getPreset, type QualityId } from "./quality";
import { loadSettings, saveSettings, type UserSettings } from "./settings";
import {
  UsbMirrorSession,
  describeError,
  getKnownUsbDevices,
  isUsbSupported,
  pickUsbDevice,
  type AudioState,
  type SessionStatus,
  type StreamSettings,
} from "./usb/session";

const STATUS_TEXT: Record<SessionStatus, string> = {
  connecting: "Membuka koneksi USB…",
  authorizing: "Cek tablet: ketuk “Izinkan” pada pop-up USB debugging",
  starting: "Memulai mirroring…",
  streaming: "Tersambung",
  reconnecting: "Menyambung ulang…",
  disconnected: "Terputus",
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function toStreamSettings(s: UserSettings): StreamSettings {
  return { quality: getPreset(s.quality), audioOnTablet: s.audioOnTablet };
}

export default function App() {
  const supported = isUsbSupported();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);

  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [session, setSession] = useState<UsbMirrorSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [audio, setAudio] = useState<AudioState>("pending");
  const [muted, setMuted] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [knownDevices, setKnownDevices] = useState<AdbDaemonWebUsbDevice[]>([]);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  const [cursorIdle, setCursorIdle] = useState(false);
  const [showExitHint, setShowExitHint] = useState(false);

  const refreshKnownDevices = useCallback(() => {
    if (supported) void getKnownUsbDevices().then(setKnownDevices);
  }, [supported]);

  useEffect(refreshKnownDevices, [refreshKnownDevices]);

  useEffect(() => saveSettings(settings), [settings]);

  useEffect(() => {
    playerRef.current?.setVolume(muted ? 0 : settings.volume);
  }, [muted, settings.volume]);

  // FPS counter
  useEffect(() => {
    if (!session) return;
    let last = session.framesRendered;
    const id = setInterval(() => {
      const current = session.framesRendered;
      setFps(Math.max(0, current - last));
      last = current;
    }, 1000);
    return () => clearInterval(id);
  }, [session]);

  // Recording timer
  useEffect(() => {
    if (recordingSince === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [recordingSince]);

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === stageRef.current;
      setFullscreen(active);
      if (active) {
        setShowExitHint(true);
        setTimeout(() => setShowExitHint(false), 3000);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Hide the cursor on the projector when the mouse stops moving.
  useEffect(() => {
    if (!fullscreen) return;
    let timer = setTimeout(() => setCursorIdle(true), 2000);
    const onMove = () => {
      setCursorIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorIdle(true), 2000);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", onMove);
      setCursorIdle(false);
    };
  }, [fullscreen]);

  const connect = async (device?: AdbDaemonWebUsbDevice) => {
    setError(null);
    const canvas = canvasRef.current;
    if (!canvas) return;

    // AudioContext must be created/resumed inside the click handler.
    const player = (playerRef.current ??= new PcmPlayer());
    void player.resume();
    player.setVolume(muted ? 0 : settings.volume);

    let picked: AdbDaemonWebUsbDevice | undefined;
    try {
      picked = device ?? (await pickUsbDevice());
    } catch (e) {
      setError(describeError(e));
      return;
    }
    if (!picked) return;

    setBusy(true);
    setVideoSize(null);
    setStatus("connecting");
    setStatusMessage(undefined);
    const next = new UsbMirrorSession(picked, canvas, player, {
      onStatus: (s, message) => {
        setStatus(s);
        setStatusMessage(message);
      },
      onAudio: setAudio,
      onVideoSize: (width, height) => setVideoSize({ width, height }),
    });
    setSession(next);
    try {
      await next.start(toStreamSettings(settings));
    } catch (e) {
      await next.close();
      setSession(null);
      setError(describeError(e));
    } finally {
      setBusy(false);
      refreshKnownDevices();
    }
  };

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecordingSince(null);
    const { blob, extension } = await recorder.stop();
    downloadBlob(blob, recordingFilename(extension));
  }, []);

  const startRecording = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || recorderRef.current) return;
    try {
      recorderRef.current = new SessionRecorder(canvas, playerRef.current?.recordStream ?? null);
      setRecordingSince(Date.now());
      setNow(Date.now());
    } catch (e) {
      setStatusMessage(`Gagal mulai rekam: ${describeError(e)}`);
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (recorderRef.current) void stopRecording();
    else startRecording();
  }, [startRecording, stopRecording]);

  const disconnect = async () => {
    await stopRecording();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    await session?.close();
    setSession(null);
    refreshKnownDevices();
  };

  const reconnect = async () => {
    const serial = session?.serial;
    await disconnect();
    const device = (await getKnownUsbDevices()).find((d) => d.serial === serial);
    void connect(device);
  };

  const toggleProjector = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen();
  }, []);

  const updateSettings = (patch: Partial<UserSettings>, restart: boolean) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (restart && session && status === "streaming") {
      void session.applySettings(toStreamSettings(next)).catch((e) => {
        setStatus("disconnected");
        setStatusMessage(describeError(e));
      });
    }
  };

  // Keyboard shortcuts: F = projector, R = record, M = mute
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, select, textarea")) return;
      const key = e.key.toLowerCase();
      if (key === "f") toggleProjector();
      else if (key === "r") toggleRecording();
      else if (key === "m") setMuted((m) => !m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, toggleProjector, toggleRecording]);

  const streaming = status === "streaming";
  const recording = recordingSince !== null;
  const recordedFor = recordingSince === null ? "" : formatDuration(now - recordingSince);

  return (
    <div className={`app ${session ? "has-session" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>CastKelas</span>
        </div>

        {session && (
          <div className="device-info">
            <span className={`dot dot-${status}`} />
            <b>{session.deviceName}</b>
            <span className="muted">
              {STATUS_TEXT[status]}
              {streaming && videoSize && ` · ${videoSize.width}×${videoSize.height} · ${fps} fps`}
            </span>
          </div>
        )}

        {session && (
          <nav className="controls">
            <div className="segmented" role="radiogroup" aria-label="Kualitas">
              {QUALITY_PRESETS.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={settings.quality === p.id}
                  className={settings.quality === p.id ? "active" : ""}
                  title={p.hint}
                  disabled={!streaming}
                  onClick={() => updateSettings({ quality: p.id as QualityId }, true)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="audio-ctl" title={audio === "unavailable" ? "Suara tidak tersedia (butuh Android 11+)" : ""}>
              <button
                className="icon-btn"
                aria-label={muted ? "Nyalakan suara" : "Matikan suara"}
                disabled={audio === "unavailable"}
                onClick={() => setMuted((m) => !m)}
              >
                <SpeakerIcon muted={muted || audio === "unavailable"} />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.volume}
                aria-label="Volume"
                disabled={audio === "unavailable"}
                onChange={(e) => {
                  setMuted(false);
                  updateSettings({ volume: Number(e.target.value) }, false);
                }}
              />
            </div>

            <label className="check" title="Android 13+: suara tetap bunyi di tablet selain di laptop">
              <input
                type="checkbox"
                checked={settings.audioOnTablet}
                disabled={!streaming}
                onChange={(e) => updateSettings({ audioOnTablet: e.target.checked }, true)}
              />
              Bunyi juga di tablet
            </label>

            <button
              className={`btn ${recording ? "btn-danger" : "btn-ghost"}`}
              disabled={!streaming && !recording}
              onClick={toggleRecording}
              title="Rekam layar + suara (R)"
            >
              {recording ? <StopIcon /> : <RecordIcon />}
              {recording ? `Stop ${recordedFor}` : "Rekam"}
            </button>

            <button className="btn btn-ghost" disabled={!streaming} onClick={toggleProjector} title="Mode proyektor (F)">
              <ProjectorIcon />
              Proyektor
            </button>

            <button className="icon-btn" aria-label="Putuskan" title="Putuskan" onClick={() => void disconnect()}>
              <PowerIcon />
            </button>
          </nav>
        )}
      </header>

      {!session && (
        <Home
          supported={supported}
          busy={busy}
          error={error}
          knownDevices={knownDevices}
          onConnect={(d) => void connect(d)}
        />
      )}

      <div
        ref={stageRef}
        className={`stage ${session ? "" : "hidden"} ${fullscreen ? "fullscreen" : ""} ${cursorIdle ? "cursor-idle" : ""}`}
        onDoubleClick={toggleProjector}
      >
        <canvas ref={canvasRef} className={streaming ? "" : "dim"} />

        {session && !streaming && (
          <div className="overlay">
            {status !== "disconnected" && <div className="spinner" />}
            <p>{statusMessage ?? STATUS_TEXT[status]}</p>
            {status === "authorizing" && (
              <p className="muted small">Centang “Selalu izinkan dari komputer ini” biar besok langsung nyambung.</p>
            )}
            {status === "disconnected" && (
              <div className="overlay-actions">
                <button className="btn btn-primary" onClick={() => void reconnect()}>
                  Sambung ulang
                </button>
                <button className="btn btn-ghost" onClick={() => void disconnect()}>
                  Kembali
                </button>
              </div>
            )}
          </div>
        )}

        {fullscreen && showExitHint && <div className="exit-hint">Tekan Esc atau klik dua kali untuk keluar</div>}
        {!fullscreen && recording && <div className="rec-badge">● REC {recordedFor}</div>}
      </div>
    </div>
  );
}
