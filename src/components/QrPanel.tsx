import { useEffect, useRef } from "react";
import QRCode from "qrcode";

export function QrPanel({ url, message }: { url: string; message?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, url, { width: 320, margin: 2, errorCorrectionLevel: "M" });
    }
  }, [url]);

  return (
    <div className="qr-panel">
      <div className="qr-box">
        <canvas ref={canvasRef} aria-label="QR code untuk menyambungkan tablet" />
      </div>
      <div className="qr-steps">
        <h2>Scan dari tablet</h2>
        {message && <p className="qr-message">{message}</p>}
        <ol>
          <li>
            Buka aplikasi <b>CastKelas</b> di tablet, ketuk <b>Scan QR</b>, arahkan ke kode ini.
          </li>
          <li>
            Ketuk <b>Mulai</b> saat tablet minta izin merekam layar.
          </li>
          <li>Layar dan suara tablet langsung muncul di sini.</li>
        </ol>
        <p className="muted small">
          Belum punya aplikasinya? Scan QR ini pakai kamera tablet, nanti ada tombol download. Tablet dan laptop boleh
          beda WiFi, asal sama-sama ada internet.
        </p>
      </div>
    </div>
  );
}
