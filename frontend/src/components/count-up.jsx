import React, { useEffect, useRef, useState } from "react";

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export const useCountUp = (to, { duration = 600, decimals = null } = {}) => {
  const target = Number.isFinite(to) ? to : 0;
  const [v, setV] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(0);
  const startedRef = useRef(false);

  useEffect(() => {
    const reduce = typeof window !== "undefined"
      && window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!startedRef.current) {
      startedRef.current = true;
      fromRef.current = 0;
    }
    if (reduce || duration <= 0) {
      fromRef.current = target;
      setV(target);
      return;
    }
    const from = fromRef.current;
    const delta = target - from;
    if (delta === 0) return;
    const t0 = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const cur = from + delta * easeOutCubic(t);
      const out = decimals == null ? cur : Number(cur.toFixed(decimals));
      setV(out);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, decimals]);

  return v;
};

export const CountUp = ({ to, duration, format, decimals }) => {
  const v = useCountUp(to, { duration, decimals });
  const text = format ? format(v) : String(v);
  return <>{text}</>;
};
