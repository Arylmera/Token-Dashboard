import React, { useRef, useEffect } from "react";
import { themeStore } from "../themes/theme.js";
import { reduceMotionStore } from "../stores/settings.js";
import { useStore } from "../stores/use-store.js";

/* Full-bleed ambient layer for the three special themes. Ported from the
   design handoff's vanilla-JS AmbientCanvas: one <canvas>, one rAF loop, a
   different per-theme effect. Non-special themes (and reduced motion) idle the
   loop. Sits behind the chrome via .a-ambient (z-index 0). */

export function AmbientCanvas() {
  const canvasRef = useRef(null);
  // Ref to the setTheme function created inside the setup effect, so the
  // theme-watching effect can call it without re-running canvas setup.
  const setThemeRef = useRef(null);

  const currentTheme = useStore(themeStore);
  const reduceMotion = useStore(reduceMotionStore);

  // Setup effect: initialise canvas, rAF loop, resize handler. Runs once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;

    const fit = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.width = window.innerWidth * DPR;
      H = canvas.height = window.innerHeight * DPR;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
    };
    window.addEventListener("resize", fit);
    fit();

    let anim = null;
    let startT = 0;
    let rafId = 0;

    const loop = (t) => {
      if (anim) anim.tick(t - startT);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    const BUILDERS = {
      // TERMINAL — phosphor noise + flicker + occasional bright scan
      terminal: () => {
        const noiseW = 240;
        const noiseH = Math.round(noiseW * (window.innerHeight / window.innerWidth));
        const off = document.createElement("canvas");
        off.width = noiseW; off.height = noiseH;
        const offCtx = off.getContext("2d");
        const img = offCtx.createImageData(noiseW, noiseH);
        let lastNoise = 0, lastScan = 0;
        return {
          tick(t) {
            ctx.clearRect(0, 0, W, H);
            if (t - lastNoise > 80) {
              const d = img.data;
              for (let i = 0; i < d.length; i += 4) {
                const v = (Math.random() < 0.5 ? 0 : Math.random() * 80) | 0;
                d[i] = 30 + v * 0.2;
                d[i + 1] = 60 + v;
                d[i + 2] = 30 + v * 0.3;
                d[i + 3] = Math.random() < 0.45 ? 18 : 0;
              }
              offCtx.putImageData(img, 0, 0);
              lastNoise = t;
            }
            ctx.globalAlpha = 0.6;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(off, 0, 0, W, H);

            ctx.globalAlpha = 0.04 + 0.02 * Math.sin(t / 90) + 0.015 * Math.sin(t / 31);
            ctx.fillStyle = "#36ff7a";
            ctx.fillRect(0, 0, W, H);

            if (t - lastScan > 4000) lastScan = t;
            const scanY = ((t - lastScan) / 1200) * H - 60 * DPR;
            if (scanY > -60 * DPR && scanY < H) {
              ctx.globalAlpha = 0.18;
              const grd = ctx.createLinearGradient(0, scanY - 80 * DPR, 0, scanY + 80 * DPR);
              grd.addColorStop(0, "rgba(54,255,122,0)");
              grd.addColorStop(0.5, "rgba(120,255,170,0.8)");
              grd.addColorStop(1, "rgba(54,255,122,0)");
              ctx.fillStyle = grd;
              ctx.fillRect(0, scanY - 80 * DPR, W, 160 * DPR);
            }
            ctx.globalAlpha = 1;
          },
        };
      },

      // COCKPIT — sparse slow star drift
      cockpit: () => {
        const stars = [];
        for (let i = 0; i < 110; i++) {
          stars.push({
            x: Math.random() * W,
            y: Math.random() * H,
            r: Math.random() * 1.0 * DPR + 0.35 * DPR,
            vx: (Math.random() * 0.025 + 0.008) * DPR,
            vy: (Math.random() * 0.014 - 0.007) * DPR,
            a: Math.random() * 0.45 + 0.2,
            phase: Math.random() * Math.PI * 2,
          });
        }
        return {
          tick(t) {
            ctx.clearRect(0, 0, W, H);
            for (const s of stars) {
              s.x += s.vx; s.y += s.vy;
              if (s.x > W + 4) s.x = -4;
              if (s.x < -4) s.x = W + 4;
              if (s.y > H + 4) s.y = -4;
              if (s.y < -4) s.y = H + 4;
              const tw = 0.55 + 0.45 * Math.sin(t / 900 + s.phase);
              ctx.globalAlpha = s.a * tw;
              ctx.fillStyle = "#c8e8ff";
              ctx.beginPath();
              ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.globalAlpha = 1;
          },
        };
      },

      // GRIMDARK — rising embers + drifting smoke
      grimdark: () => {
        const embers = [];
        const spawn = () => {
          embers.push({
            x: Math.random() * W,
            y: H + 10 * DPR,
            vy: -(Math.random() * 0.4 + 0.18) * DPR,
            vx: (Math.random() - 0.5) * 0.18 * DPR,
            r: Math.random() * 1.6 * DPR + 0.6 * DPR,
            life: 0,
            maxLife: Math.random() * 6000 + 4000,
            hue: 18 + Math.random() * 14,
          });
        };
        for (let i = 0; i < 60; i++) { spawn(); embers[i].y = Math.random() * H; embers[i].life = Math.random() * 3000; }

        const smoke = [];
        for (let i = 0; i < 6; i++) {
          smoke.push({
            x: Math.random() * W,
            y: Math.random() * H,
            r: 200 * DPR + Math.random() * 220 * DPR,
            a: 0.05 + Math.random() * 0.04,
            vx: (Math.random() - 0.5) * 0.06 * DPR,
            vy: -Math.random() * 0.04 * DPR - 0.02 * DPR,
          });
        }

        let lastSpawn = 0;
        return {
          tick(t) {
            ctx.clearRect(0, 0, W, H);
            for (const s of smoke) {
              s.x += s.vx; s.y += s.vy;
              if (s.y + s.r < 0) { s.y = H + s.r; s.x = Math.random() * W; }
              if (s.x < -s.r) s.x = W + s.r;
              if (s.x > W + s.r) s.x = -s.r;
              const grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
              grd.addColorStop(0, `rgba(60,30,18,${s.a})`);
              grd.addColorStop(1, "rgba(60,30,18,0)");
              ctx.fillStyle = grd;
              ctx.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
            }

            if (t - lastSpawn > 60) { spawn(); lastSpawn = t; }

            for (let i = embers.length - 1; i >= 0; i--) {
              const e = embers[i];
              e.life += 16;
              e.x += e.vx; e.y += e.vy;
              e.vx += (Math.random() - 0.5) * 0.02 * DPR;
              if (e.life > e.maxLife || e.y < -20 * DPR) { embers.splice(i, 1); continue; }
              const lifeRatio = e.life / e.maxLife;
              const alpha = (1 - lifeRatio) * 0.85;
              ctx.fillStyle = `hsla(${e.hue}, 95%, ${55 + 10 * Math.sin(e.life / 200)}%, ${alpha})`;
              ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill();
              ctx.fillStyle = `hsla(${e.hue}, 95%, 60%, ${alpha * 0.18})`;
              ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 4, 0, Math.PI * 2); ctx.fill();
            }

            const band = ctx.createLinearGradient(0, H * 0.7, 0, H);
            band.addColorStop(0, "rgba(184,35,26,0)");
            band.addColorStop(1, "rgba(184,35,26,0.18)");
            ctx.fillStyle = band;
            ctx.fillRect(0, H * 0.7, W, H * 0.3);
          },
        };
      },
    };

    const setTheme = (key) => {
      if (anim && anim.teardown) anim.teardown();
      ctx.clearRect(0, 0, W, H);
      anim = key && BUILDERS[key] ? BUILDERS[key]() : null;
      startT = performance.now();
    };

    // Expose setTheme so the theme-watching effect can call it.
    setThemeRef.current = setTheme;

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", fit);
      ctx.clearRect(0, 0, W, H);
      setThemeRef.current = null;
    };
  }, []); // runs once on mount

  // Theme/motion-watching effect: rebuilds the active animation when theme or
  // reduceMotion changes. Mirrors the original createEffect inside onMount.
  useEffect(() => {
    const setTheme = setThemeRef.current;
    if (!setTheme) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const BUILDER_KEYS = ["terminal", "cockpit", "grimdark"];
    const idle = reduceMotion || prefersReduced;
    setTheme(idle ? null : BUILDER_KEYS.includes(currentTheme) ? currentTheme : null);
  }, [currentTheme, reduceMotion]);

  return (
    <div className="a-ambient" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
