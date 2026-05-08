import React from "react";
import { createRoot } from "react-dom/client";
import { DirectionA } from "./src/app.jsx";
import "./src/api-client.js";

const Shell = () => (
  <div className="dir-a-root" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
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
    es.onmessage = async () => { await window.RELOAD_DATA(); render(); };
  } catch (_) {}
})();
