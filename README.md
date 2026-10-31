# CastKelas

Mirror layar tablet/HP **Android** ke laptop untuk mengajar, langsung dari browser. Suara tablet ikut keluar di laptop.

## Fitur (Fase 1)

- **Mode USB**: colok kabel, klik *Sambungkan via USB*. Tablet tidak perlu install aplikasi apa pun.
- **Suara di laptop**: laptop jadi speaker (Android 11+). Opsi *Bunyi juga di tablet* (Android 13+).
- **Preset kualitas**: Hemat / Seimbang / Tajam, bisa diganti saat mirroring.
- **Mode proyektor**: fullscreen bersih, kursor otomatis hilang. Shortcut `F`, keluar dengan `Esc` atau klik dua kali.
- **Rekam sesi**: hasil MP4 (video + suara) langsung tersimpan di laptop. Shortcut `R`.
- **Sambung ulang otomatis** kalau kabel kecabut lalu dicolok lagi.
- **Bisa offline**: setelah pernah dibuka sekali, web tetap jalan tanpa internet (mode USB).

Fase 2 (berikutnya): **Mode QR** wireless + aplikasi Android pendamping.

## Syarat

- Laptop: **Google Chrome** atau **Microsoft Edge** (butuh WebUSB + WebCodecs).
- Tablet: Android 5+ untuk video, Android 11+ untuk suara. *USB debugging* aktif.
- Tidak ada program lain yang memakai adb (Android Studio, scrcpy, `adb server`). Kalau ada, jalankan `adb kill-server`.

## Development

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # output ke dist/
npm run preview   # tes hasil build (service worker offline aktif di sini)
```

## Deploy ke Vercel

Import repo ini di Vercel. Framework terdeteksi otomatis sebagai **Vite** (build `npm run build`, output `dist`). Tidak ada environment variable yang dibutuhkan di Fase 1.

## Cara kerja

Browser laptop bicara langsung ke tablet lewat protokol ADB via WebUSB ([Tango](https://github.com/yume-chan/ya-webadb)), lalu menjalankan [scrcpy](https://github.com/Genymobile/scrcpy) server v3.3.3 di tablet. Video H.264 di-decode dengan WebCodecs ke canvas, audio PCM diputar lewat Web Audio.

`public/scrcpy-server-v3.3.3` adalah binary resmi dari rilis scrcpy (Apache-2.0), SHA-256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`.
