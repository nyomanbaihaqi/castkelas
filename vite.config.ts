import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";

// Emits sw.js with a precache list of every built asset, so the app keeps
// working offline (USB mode needs no internet) after it has been opened once.
function offlineServiceWorker(): Plugin {
  return {
    name: "castkelas-offline-sw",
    apply: "build",
    generateBundle(_, bundle) {
      const publicFiles = readdirSync("public");
      const files = [
        "/",
        ...Object.keys(bundle).filter((f) => !f.endsWith(".map")),
        ...publicFiles,
      ].map((f) => (f.startsWith("/") ? f : `/${f}`));
      const version = createHash("sha256").update(files.join("|")).digest("hex").slice(0, 12);

      const source = `
const CACHE = "castkelas-${version}";
const PRECACHE = ${JSON.stringify(files)};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    // Network first so updates land quickly; fall back to the cached shell offline.
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineServiceWorker()],
});
