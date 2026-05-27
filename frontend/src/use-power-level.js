import { useEffect, useState } from "react";
import { clampLevel, MIN_LEVEL } from "./levels.js";

const EVENT = "td:level-changed";

export const broadcastPowerLevel = (next) => {
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: clampLevel(next) })); } catch (_) {}
};

export const usePowerLevel = () => {
  const [level, setLevel] = useState(MIN_LEVEL);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.power_level != null) setLevel(clampLevel(d.power_level)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    const onLocal = (e) => setLevel(clampLevel(e.detail));
    window.addEventListener(EVENT, onLocal);
    return () => { cancelled = true; window.removeEventListener(EVENT, onLocal); };
  }, []);
  return [level, loaded];
};
