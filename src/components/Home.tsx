import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { QrIcon, UsbIcon } from "./Icons";

interface HomeProps {
  supported: boolean;
  busy: boolean;
  error: string | null;
  knownDevices: AdbDaemonWebUsbDevice[];
  onConnect(device?: AdbDaemonWebUsbDevice): void;
}

export function Home({ supported, busy, error, knownDevices, onConnect }: HomeProps) {
  return (
    <main className="home">
      <section className="hero">
        <h1>Tampilkan layar tablet di laptop</h1>
        <p className="lead">
          Mirror layar tablet atau HP Android lengkap dengan suaranya, buat mengajar di kelas. Stabil, tanpa ribet
          satu-WiFi.
        </p>
      </section>

      {!supported && (
        <div className="notice notice-warn">
          Browser ini belum didukung. Buka CastKelas pakai <b>Google Chrome</b> atau <b>Microsoft Edge</b> di laptop.
        </div>
      )}
      {error && <div className="notice notice-error">{error}</div>}

      <section className="modes">
        <article className="mode-card mode-primary">
          <div className="mode-head">
            <span className="mode-icon">
              <UsbIcon />
            </span>
            <div>
              <h2>Mode USB</h2>
              <p>Paling stabil, latensi paling kecil. Tidak butuh internet.</p>
            </div>
          </div>

          {knownDevices.length > 0 && (
            <div className="known">
              {knownDevices.map((d) => (
                <button
                  key={d.serial}
                  className="btn btn-primary"
                  disabled={!supported || busy}
                  onClick={() => onConnect(d)}
                >
                  Sambungkan {d.name || d.serial}
                </button>
              ))}
            </div>
          )}

          <button
            className={knownDevices.length > 0 ? "btn btn-ghost" : "btn btn-primary btn-lg"}
            disabled={!supported || busy}
            onClick={() => onConnect()}
          >
            {knownDevices.length > 0 ? "Pilih perangkat lain…" : "Sambungkan via USB"}
          </button>
        </article>

        <article className="mode-card mode-soon">
          <div className="mode-head">
            <span className="mode-icon">
              <QrIcon />
            </span>
            <div>
              <h2>
                Mode QR <span className="badge">Segera hadir</span>
              </h2>
              <p>Tanpa kabel: scan QR dari aplikasi CastKelas di tablet. Tembus WiFi sekolah &amp; hotspot.</p>
            </div>
          </div>
        </article>
      </section>

      <section className="guide">
        <h3>Pertama kali pakai mode USB?</h3>
        <ol>
          <li>
            Di tablet buka <b>Setelan → Tentang tablet</b>, ketuk <b>Nomor bentukan (Build number)</b> 7 kali sampai
            muncul "Anda sekarang developer".
          </li>
          <li>
            Buka <b>Setelan → Opsi pengembang</b>, nyalakan <b>USB debugging</b>.
          </li>
          <li>
            Colok kabel USB ke laptop, klik <b>Sambungkan via USB</b>, lalu pilih tablet di daftar.
          </li>
          <li>
            Di tablet muncul pop-up <b>"Izinkan USB debugging?"</b>, centang <b>Selalu izinkan</b> lalu ketuk{" "}
            <b>Izinkan</b>.
          </li>
        </ol>
        <p className="tips">
          Kalau gagal: pastikan kabelnya kabel data (bukan cuma cas), dan tutup program lain yang memakai adb (Android
          Studio, scrcpy, dsb). Suara butuh Android 11 ke atas.
        </p>
      </section>
    </main>
  );
}
