import { useCallback, useEffect, useRef, useState } from "react";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { Home } from "./components/Home";
import { PowerIcon, ProjectorIcon, RecordIcon, SpeakerIcon, StopIcon } from "./components/Icons";
import { QrPanel } from "./components/QrPanel";
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
  type SessionStatus,
  type StreamSettings,
} from "./usb/session";
import { loadWirelessConfig, type WirelessConfig } from "./wireless/config";
import { WirelessReceiver, type WirelessStatus } from "./wireless/receiver";

type ViewStatus = SessionStatus | WirelessStatus;
type Mode = "usb" | "wireless";

const STATUS_TEXT: Record<ViewStatus, string> = {
  connecting: "Menyambung…",
  authorizing: "Cek tablet: ketuk “Izinkan” pada pop-up USB debugging",
  starting: "Memulai mirroring…",
  streaming: "Tersambung",
  reconnecting: "Menyambung ulang…",
  disconnected: "Terputus",
  waiting: "Menunggu tablet scan QR",
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
  const usbSupported = isUsbSupported();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);

  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [mode, setMode] = useState<Mode | null>(null);
  const [usbSession, setUsbSession] = useState<UsbMirrorSession | null>(null);
  const [receiver, setReceiver] = useState<WirelessReceiver | null>(null);
  const [wirelessConfig, setWirelessConfig] = useState<WirelessConfig | null | undefined>(undefined);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<ViewStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [deviceName, setDeviceName] = useState("Tablet");
  const [audio, setAudio] = useState<"pending" | "on" | "unavailable">("pending");
  const [muted, setMuted] = useState(false);
  const [stats, setStats] = useState<{ fps: number; width: number; height: number; relayed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [knownDevices, setKnownDevices] = useState<AdbDaemonWebUsbDevice[]>([]);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  const [cursorIdle, setCursorIdle] = useState(false);
  const [showExitHint, setShowExitHint] = useState(false);

  const refreshKnownDevices = useCallback(() => {
    if (usbSupported) void getKnownUsbDevices().then(setKnownDevices);
  }, [usbSupported]);

  useEffect(refreshKnownDevices, [refreshKnownDevices]);
  useEffect(() => void loadWirelessConfig().then(setWirelessConfig), []);
  useEffect(() => saveSettings(settings), [settings]);

  // Speaker volume (recordings are unaffected in USB mode).
  useEffect(() => {
    playerRef.current?.setVolume(muted ? 0 : settings.volume);
    if (videoRef.current) {
      videoRef.current.volume = settings.volume;
      videoRef.current.muted = muted;
    }
  }, [muted, settings.volume, remoteStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.srcObject === remoteStream) return;
    video.srcObject = remoteStream;
    if (remoteStream) void video.play().catch(() => {});
  }, [remoteStream]);

  // Stats: fps + resolution
  useEffect(() => {
    if (usbSession) {
      let last = usbSession.framesRendered;
      const id = setInterval(() => {
        const current = usbSession.framesRendered;
        const canvas = canvasRef.current;
        setStats({ fps: Math.max(0, current - last), width: canvas?.width ?? 0, height: canvas?.height ?? 0, relayed: false });
        last = current;
      }, 1000);
      return () => clearInterval(id);
    }
    if (receiver) {
      const id = setInterval(() => void receiver.getStats().then(setStats), 1000);
      return () => clearInterval(id);
    }
  }, [usbSession, receiver]);

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

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecordingSince(null);
    const { blob, extension } = await recorder.stop();
    downloadBlob(blob, recordingFilename(extension));
  }, []);

  const resetView = () => {
    setStats(null);
    setStatusMessage(undefined);
    setAudio("pending");
    setDeviceName("Tablet");
    setError(null);
  };

  const connectUsb = async (device?: AdbDaemonWebUsbDevice) => {
    resetView();
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
    setStatus("connecting");
    setDeviceName(picked.name || "Tablet");
    const next = new UsbMirrorSession(picked, canvas, player, {
      onStatus: (s, message) => {
        setStatus(s);
        setStatusMessage(message);
        if (s === "streaming") setDeviceName(next.deviceName);
      },
      onAudio: setAudio,
      onVideoSize: () => {},
    });
    setMode("usb");
    setUsbSession(next);
    try {
      await next.start(toStreamSettings(settings));
    } catch (e) {
      await next.close();
      setUsbSession(null);
      setMode(null);
      setError(describeError(e));
    } finally {
      setBusy(false);
      refreshKnownDevices();
    }
  };

  const startWireless = async () => {
    if (!wirelessConfig) return;
    resetView();
    setBusy(true);
    setStatus("connecting");
    let previousStream: MediaStream | null = null;
    const next = new WirelessReceiver(wirelessConfig, getPreset(settings.quality), {
      onStatus: (s, message) => {
        setStatus(s);
        setStatusMessage(message);
        if (s === "waiting") {
          setRemoteStream(null);
          previousStream = null;
        }
      },
      onStream: (stream) => {
        if (stream !== previousStream) {
          // A reconnect brings a new stream; close the old recording cleanly.
          void stopRecording();
          previousStream = stream;
        }
        setRemoteStream(stream);
      },
      onDevice: setDeviceName,
      onAudio: setAudio,
    });
    setMode("wireless");
    setReceiver(next);
    try {
      await next.start();
    } catch (e) {
      await next.close().catch(() => {});
      setReceiver(null);
      setMode(null);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const startRecording = useCallback(() => {
    if (recorderRef.current) return;
    try {
      if (mode === "usb" && canvasRef.current) {
        recorderRef.current = SessionRecorder.fromCanvas(canvasRef.current, playerRef.current?.recordStream ?? null);
      } else if (mode === "wireless" && remoteStream) {
        recorderRef.current = new SessionRecorder(new MediaStream(remoteStream.getTracks()));
      } else {
        return;
      }
      setRecordingSince(Date.now());
      setNow(Date.now());
    } catch (e) {
      setStatusMessage(`Gagal mulai rekam: ${describeError(e)}`);
    }
  }, [mode, remoteStream]);

  const toggleRecording = useCallback(() => {
    if (recorderRef.current) void stopRecording();
    else startRecording();
  }, [startRecording, stopRecording]);

  const disconnect = async () => {
    await stopRecording();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    await usbSession?.close();
    await receiver?.close().catch(() => {});
    setUsbSession(null);
    setReceiver(null);
    setRemoteStream(null);
    setMode(null);
    refreshKnownDevices();
  };

  const reconnectUsb = async () => {
    const serial = usbSession?.serial;
    await disconnect();
    const device = (await getKnownUsbDevices()).find((d) => d.serial === serial);
    void connectUsb(device);
  };

  const toggleProjector = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen();
  }, []);

  const updateSettings = (patch: Partial<UserSettings>, apply: boolean) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (!apply || status !== "streaming") return;
    if (usbSession) {
      void usbSession.applySettings(toStreamSettings(next)).catch((e) => {
        setStatus("disconnected");
        setStatusMessage(describeError(e));
      });
    }
    receiver?.setQuality(getPreset(next.quality));
  };

  // Keyboard shortcuts: F = projector, R = record, M = mute
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, select, textarea")) return;
      const key = e.key.toLowerCase();
      if (key === "f") toggleProjector();
      else if (key === "r") toggleRecording();
      else if (key === "m") setMuted((m) => !m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, toggleProjector, toggleRecording]);

  const streaming = status === "streaming";
  const recording = recordingSince !== null;
  const recordedFor = recordingSince === null ? "" : formatDuration(now - recordingSince);
  const showQr = mode === "wireless" && receiver && status === "waiting";

  return (
    <div className={`app ${mode ? "has-session" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>CastKelas</span>
        </div>

        {mode && (
          <div className="device-info">
            <span className={`dot dot-${status}`} />
            <b>{mode === "usb" ? deviceName : status === "waiting" ? "Mode QR" : deviceName}</b>
            <span className="muted">
              {STATUS_TEXT[status]}
              {streaming && stats && stats.width > 0 && ` · ${stats.width}×${stats.height} · ${stats.fps} fps`}
              {streaming && stats?.relayed && " · via relay"}
            </span>
          </div>
        )}

        {mode && (
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

            {mode === "usb" && (
              <label className="check" title="Android 13+: suara tetap bunyi di tablet selain di laptop">
                <input
                  type="checkbox"
                  checked={settings.audioOnTablet}
                  disabled={!streaming}
                  onChange={(e) => updateSettings({ audioOnTablet: e.target.checked }, true)}
                />
                Bunyi juga di tablet
              </label>
            )}

            <button
              className={`btn ${recording ? "btn-danger" : "btn-ghost"}`}
              disabled={!streaming && !recording}
              onClick={toggleRecording}
              title="Rekam layar + suara (R)"
            >
              {recording ? <StopIcon /> : <RecordIcon />}
              {recording ? `Stop ${recordedFor}` : "Rekam"}
            </button>

            <button className="btn btn-ghost" onClick={toggleProjector} title="Mode proyektor (F)">
              <ProjectorIcon />
              Proyektor
            </button>

            <button className="icon-btn" aria-label="Putuskan" title="Putuskan" onClick={() => void disconnect()}>
              <PowerIcon />
            </button>
          </nav>
        )}
      </header>

      {!mode && (
        <Home
          usbSupported={usbSupported}
          wirelessConfig={wirelessConfig}
          busy={busy}
          error={error}
          knownDevices={knownDevices}
          onConnectUsb={(d) => void connectUsb(d)}
          onStartWireless={() => void startWireless()}
        />
      )}

      <div
        ref={stageRef}
        className={`stage ${mode ? "" : "hidden"} ${fullscreen ? "fullscreen" : ""} ${cursorIdle ? "cursor-idle" : ""}`}
        onDoubleClick={toggleProjector}
      >
        <canvas ref={canvasRef} className={`${mode === "usb" ? "" : "hidden"} ${streaming ? "" : "dim"}`} />
        <video
          ref={videoRef}
          className={`${mode === "wireless" && !showQr ? "" : "hidden"} ${streaming ? "" : "dim"}`}
          autoPlay
          playsInline
        />

        {showQr && receiver && <QrPanel url={receiver.joinUrl} message={statusMessage} />}

        {mode && !streaming && !showQr && (
          <div className="overlay">
            {status !== "disconnected" && <div className="spinner" />}
            <p>{statusMessage ?? STATUS_TEXT[status]}</p>
            {status === "authorizing" && (
              <p className="muted small">Centang “Selalu izinkan dari komputer ini” biar besok langsung nyambung.</p>
            )}
            {status === "connecting" && mode === "wireless" && (
              <p className="muted small">Di tablet, ketuk “Mulai” saat diminta izin merekam layar.</p>
            )}
            {status === "disconnected" && (
              <div className="overlay-actions">
                {mode === "usb" && (
                  <button className="btn btn-primary" onClick={() => void reconnectUsb()}>
                    Sambung ulang
                  </button>
                )}
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
