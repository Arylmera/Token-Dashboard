import { useEffect, useState } from "react";

// "Calm" / reduced-motion preference for the special themes. When on, the
// ambient canvas idles and the banner/scanline/blip animations stop.
// localStorage-backed (same per-session pattern as density); a custom event
// keeps the Settings toggle and the app shell in sync without prop threading.
const KEY = "td.calmfx.v1";
const EVT = "td:calmfx";

export const getCalmFx = () => {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
};

export const setCalmFx = (on) => {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) {}
  try { window.dispatchEvent(new CustomEvent(EVT, { detail: !!on })); } catch (_) {}
};

export const useCalmFx = () => {
  const [calm, setCalm] = useState(getCalmFx);
  useEffect(() => {
    const onEvt = (e) => setCalm(!!e.detail);
    window.addEventListener(EVT, onEvt);
    return () => window.removeEventListener(EVT, onEvt);
  }, []);
  return [calm, (v) => setCalmFx(!!v)];
};
