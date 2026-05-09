import React from "react";
import { createRoot } from "react-dom/client";
import { DirectionA } from "./src/app.jsx";
import "./src/api-client.js";

const Shell = () => (
  <div className="dir-a-root" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <DirectionA />
  </div>
);

(async () => {
  await window.DATA_READY;
  // Tag the body with the host platform so CSS can reserve space for the
  // native window controls on the correct side (mac=left, win=right).
  try {
    const plat = (window.td && window.td.platform) || "";
    if (plat) document.body.classList.add(`platform-${plat}`);
  } catch (_) {}
  const root = createRoot(document.getElementById("root"));
  const render = () => root.render(<Shell />);
  render();
  try {
    const es = new EventSource("/api/stream");
    es.onmessage = async (e) => {
      let evt = null;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (!evt) return;
      if (evt.type === "bundle") {
        // Dev mode: esbuild rebuilt dist/app.js, hard-reload to pick it up.
        location.reload();
        return;
      }
      if (evt.type !== "scan") return;
      if (evt.changed && window.RELOAD_DELTA) {
        await window.RELOAD_DELTA(evt.changed);
      } else {
        await window.RELOAD_DATA();   // fallback for old server / missing changed
      }
      render();
    };
  } catch (_) {}
})();
