# CastKelas

Mirror layar tablet/HP **Android** ke laptop untuk mengajar, langsung dari browser. Suara tablet ikut keluar di laptop.

## Dua mode koneksi

| | Mode USB | Mode QR |
|---|---|---|
| Kabel | Ya | Tidak |
| Aplikasi di tablet | Tidak perlu | APK CastKelas |
| Internet | Tidak perlu | Perlu (laptop & tablet), boleh beda jaringan |
| Suara | Android 11+ | Android 10+ |

**Fitur bersama:** preset kualitas (Hemat / Seimbang / Tajam), mode proyektor fullscreen (`F`), rekam sesi ke MP4 dengan suara (`R`), mute (`M`), sambung ulang otomatis.

Mode QR memakai WebRTC. Kalau WiFi sekolah memblokir koneksi antar-perangkat (client isolation), koneksi otomatis lewat server relay TURN, jadi tetap tersambung.

## Syarat

- Laptop: **Google Chrome** atau **Microsoft Edge**.
- Mode USB: *USB debugging* aktif di tablet, dan tidak ada program lain yang memakai adb (`adb kill-server`).
- Mode QR: install APK CastKelas di tablet (lihat *Releases* repo ini).

## Struktur

```
src/            Web app (Vite + React)
  usb/          Mode USB: WebUSB → ADB → scrcpy 3.3.3
  wireless/     Mode QR: penerima WebRTC + sinyal Supabase Realtime
api/config.js   Vercel Function: config Supabase + kredensial TURN
android/        Aplikasi Android pendamping (Kotlin)
```

## Setup Mode QR (sekali saja)

1. **Supabase** (akun nyomanbaihaqi@gmail.com): buat project, Free plan, region Singapore. Tidak perlu tabel. Pastikan *Realtime → Settings → Allow public access* aktif.
2. **Cloudflare TURN** (opsional tapi disarankan untuk WiFi sekolah): dash.cloudflare.com → *Realtime → TURN Server* → buat key. Free 1 TB/bulan.
3. **Environment variables di Vercel** (Project → Settings → Environment Variables):

   | Nama | Isi |
   |---|---|
   | `SUPABASE_URL` | `https://<project>.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` (atau anon key) |
   | `CLOUDFLARE_TURN_KEY_ID` | Turn Token ID |
   | `CLOUDFLARE_TURN_API_TOKEN` | API Token TURN |
   | `APK_URL` | (opsional) link download APK kalau repo private |

   Redeploy setelah mengisi.

4. **Signing APK**: GitHub Actions membangun APK setiap ada perubahan di `android/`. Rilis APK hanya dipublikasikan kalau secret berikut ada di repo (Settings → Secrets → Actions): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Keystore jangan sampai hilang, karena tanpa keystore yang sama, aplikasi tidak bisa di-update tanpa uninstall.

## Development

```bash
npm install
npm run dev       # http://localhost:5173 (Mode QR: isi .env dari .env.example)
npm run build
npm run preview   # tes hasil build, termasuk service worker offline
```

## Lisensi pihak ketiga

- `public/scrcpy-server-v3.3.3`: binary resmi [scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0), SHA-256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`.
- [Tango ADB](https://github.com/yume-chan/ya-webadb) (MIT), [WebRTC SDK LiveKit](https://github.com/webrtc-sdk/android) (BSD), [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded) (Apache-2.0).
