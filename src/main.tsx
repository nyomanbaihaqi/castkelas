import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { JoinPage } from "./components/JoinPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{location.pathname === "/join" ? <JoinPage /> : <App />}</StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW gagal didaftarkan", e));
  });
}
