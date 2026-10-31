import { useEffect, useState } from "react";
import { ANDROID_PACKAGE, DEFAULT_APK_URL, loadWirelessConfig } from "../wireless/config";

/**
 * Landing page for the QR code when it's scanned with a normal camera app
 * instead of the CastKelas app: hands off to the app, or offers the APK.
 */
export function JoinPage() {
  const channel = new URLSearchParams(location.search).get("c") ?? "";
  const [apkUrl, setApkUrl] = useState(DEFAULT_APK_URL);
  const isAndroid = /android/i.test(navigator.userAgent);

  useEffect(() => {
    void loadWirelessConfig().then((c) => c && setApkUrl(c.apkUrl));
  }, []);

  const appLink =
    `intent://join?o=${encodeURIComponent(location.origin)}&c=${encodeURIComponent(channel)}` +
    `#Intent;scheme=castkelas;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(apkUrl)};end`;

  return (
    <main className="join">
      <img src="/icon.svg" alt="" width={64} height={64} />
      <h1>CastKelas</h1>
      {!channel ? (
        <p className="muted">Link ini tidak lengkap. Scan ulang QR di layar laptop.</p>
      ) : isAndroid ? (
        <>
          <p className="muted">Ketuk tombol di bawah untuk mulai cast layar tablet ini ke laptop.</p>
          <a className="btn btn-primary btn-lg" href={appLink}>
            Buka aplikasi CastKelas
          </a>
          <p className="muted small">Belum punya aplikasinya?</p>
          <a className="btn btn-ghost" href={apkUrl}>
            Download aplikasi (APK)
          </a>
          <p className="muted small">
            Setelah download, buka file-nya lalu izinkan “Instal aplikasi tidak dikenal” bila diminta. Setelah terpasang,
            scan ulang QR di laptop.
          </p>
        </>
      ) : (
        <p className="muted">Scan QR ini pakai tablet atau HP Android yang mau di-cast.</p>
      )}
    </main>
  );
}
