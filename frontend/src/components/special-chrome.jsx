import React, { useEffect, useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtPct, fmtTokens } from "../format.js";

// ── Banner strips under the topbar (one per special theme) ────────────────

const BOOT_LINES = [
  ["[ OK ]", " mounting /sys/token-dashboard"],
  ["[ OK ]", " scanner daemon online"],
  ["[ OK ]", " sse bus attached"],
  ["[ OK ]", " pricing table loaded"],
  ["[ OK ]", " jsonl transcripts indexed"],
  ["[ OK ]", " cache warm · dedup primed"],
  ["[ OK ]", " tips engine armed"],
  ["", "awaiting input_"],
];

const TerminalBanner = () => {
  // Duplicate the item list inside the track so the -50% marquee loops seamlessly.
  const items = [...BOOT_LINES, ...BOOT_LINES];
  return (
    <div className="a-banner-terminal" aria-hidden="true">
      <div className="track">
        {items.map(([ok, rest], i) => (
          <span key={i}>
            {ok && <span className="ok">{ok}</span>}
            {rest}
          </span>
        ))}
      </div>
    </div>
  );
};

const Sep = () => <i className="sep" aria-hidden="true" />;

const CockpitBanner = () => {
  const t = D.totals || {};
  const reserves = t.cacheHitRate != null ? fmtPct(t.cacheHitRate) : "—";
  return (
    <div className="a-banner-cockpit" aria-hidden="true">
      <span className="blip" /> link <b>stable</b> <Sep /> telemetry <b>nominal</b> <Sep />
      bearing <b>274°</b> <Sep /> reserves <span className="amber">{reserves}</span> <Sep />
      eta <b>03:42 zulu</b>
    </div>
  );
};

const GrimdarkBanner = () => (
  <div className="a-banner-grimdark" aria-hidden="true">
    by torch and oath <i className="sep" /> <b>the watch holds</b> <i className="sep" />
    orbit 0331.M3 <i className="sep" /> sector ix
  </div>
);

export const ThemeBanner = ({ themeId }) => {
  if (themeId === "terminal") return <TerminalBanner />;
  if (themeId === "cockpit") return <CockpitBanner />;
  if (themeId === "grimdark") return <GrimdarkBanner />;
  return null;
};

// ── Freshness ticker (seconds since the last data push) ───────────────────

const useFreshness = () => {
  const [stamp, setStamp] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const onData = () => { const t = Date.now(); setStamp(t); setNow(t); };
    window.addEventListener("td:data", onData);
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => { window.removeEventListener("td:data", onData); clearInterval(id); };
  }, []);
  const s = Math.max(0, Math.floor((now - stamp) / 1000));
  if (s < 30) return { label: s < 3 ? "STABLE" : `${s}s`, stale: false };
  const m = Math.floor(s / 60);
  return { label: m < 1 ? "STALE" : `STALE ${m}m`, stale: true };
};

// Cockpit HUD overlay — decorative chrome wired to real dashboard metrics.
export const CockpitHud = () => {
  const link = useFreshness();
  const t = D.totals || {};
  return (
    <div className="a-hud" aria-hidden="true">
      <div>CACHE <span className="val">{t.cacheHitRate != null ? fmtPct(t.cacheHitRate) : "—"}</span></div>
      <div>SPEND <span className="val">{fmtCost(t.today || 0)}</span></div>
      <div>PAYLOAD <span className="val">{fmtTokens(t.todayTokens || 0)}</span></div>
      <div className="a-hud-tape">
        <span className="blip" /> LINK <b className={link.stale ? "amb" : undefined}>{link.label}</b>
      </div>
    </div>
  );
};

// ── Cockpit card corner brackets ──────────────────────────────────────────
// The cockpit theme wants four L-shaped brackets on every .a-card. Cards are
// authored inline across many routes with no shared component, so rather than
// touch each one we decorate the live DOM when the cockpit theme is active and
// re-apply after route/data re-renders. Brackets are theme-scoped in CSS, so
// they're invisible under other themes even if a stale one lingers a frame.
const BR_CLASSES = ["tl", "tr", "bl", "br"];

const decorateCards = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return;
  root.querySelectorAll(".a-card").forEach((card) => {
    if (card.querySelector(":scope > .br")) return;
    for (const c of BR_CLASSES) {
      const span = document.createElement("span");
      span.className = `br ${c}`;
      card.appendChild(span);
    }
  });
};

const stripBrackets = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return;
  root.querySelectorAll(".a-card > .br").forEach((el) => el.remove());
};

export const useCockpitBrackets = (active) => {
  useEffect(() => {
    const sel = ".dir-a-root";
    if (!active) { stripBrackets(sel); return; }
    decorateCards(sel);
    const main = document.querySelector(".a-main-area");
    if (!main) return;
    const obs = new MutationObserver(() => decorateCards(sel));
    obs.observe(main, { childList: true, subtree: true });
    return () => { obs.disconnect(); stripBrackets(sel); };
  }, [active]);
};
