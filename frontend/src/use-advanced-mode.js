import { useEffect, useState } from "react";

const EVENT = "td:advanced-changed";

export const broadcastAdvancedMode = (next) => {
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: !!next })); } catch (_) {}
};

export const useAdvancedMode = () => {
  const [advanced, setAdvanced] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d) setAdvanced(!!d.advanced_mode); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    const onLocal = (e) => setAdvanced(!!e.detail);
    window.addEventListener(EVENT, onLocal);
    return () => { cancelled = true; window.removeEventListener(EVENT, onLocal); };
  }, []);
  return [advanced, loaded];
};
