import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["S","M","T","W","T","F","S"];

const pad = (n) => String(n).padStart(2, "0");
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseYmd = (s) => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2]-1, +m[3]);
  return isNaN(d) ? null : d;
};
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const fmtLabel = (d) => d ? `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` : "—";

export const DateInput = ({ value, onChange, ariaLabel }) => {
  const initial = parseYmd(value) || new Date();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(initial);
  const [viewMonth, setViewMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const btnRef = useRef(null);
  const [popPos, setPopPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const v = parseYmd(value);
    if (v) { setCursor(v); setViewMonth(new Date(v.getFullYear(), v.getMonth(), 1)); }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      const inTrigger = wrapRef.current && wrapRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inTrigger && !inPop) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const place = () => {
      const r = btnRef.current.getBoundingClientRect();
      const popW = 220;
      const left = Math.min(window.innerWidth - popW - 8, Math.max(8, r.right - popW));
      setPopPos({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const commit = (d) => {
    onChange(toYmd(d));
    setCursor(d);
    setOpen(false);
    if (btnRef.current) btnRef.current.focus();
  };

  const onKey = (e) => {
    if (!open) return;
    let next = null;
    if (e.key === "ArrowLeft") next = addDays(cursor, -1);
    else if (e.key === "ArrowRight") next = addDays(cursor, 1);
    else if (e.key === "ArrowUp") next = addDays(cursor, -7);
    else if (e.key === "ArrowDown") next = addDays(cursor, 7);
    else if (e.key === "Enter") { e.preventDefault(); commit(cursor); return; }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); btnRef.current && btnRef.current.focus(); return; }
    if (next) {
      e.preventDefault();
      setCursor(next);
      setViewMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    }
  };

  const monthStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const firstWeekday = monthStart.getDay();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth()+1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d));

  const selected = parseYmd(value);
  const today = new Date();

  const shiftMonth = (n) => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth()+n, 1));

  return (
    <span className="a-date-input" ref={wrapRef} onKeyDown={onKey}>
      <button
        type="button"
        ref={btnRef}
        className="a-date-input-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {fmtLabel(selected)}
      </button>
      {open && createPortal(
        <div
          className="a-date-pop"
          role="dialog"
          ref={popRef}
          style={{ top: popPos.top, left: popPos.left }}
        >
          <div className="a-date-pop-head">
            <button type="button" className="a-date-pop-nav" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
            <span className="a-date-pop-title">{MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}</span>
            <button type="button" className="a-date-pop-nav" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
          </div>
          <div className="a-date-pop-grid a-date-pop-weekdays">
            {WEEKDAYS.map((w, i) => <span key={i} className="a-date-pop-wd">{w}</span>)}
          </div>
          <div className="a-date-pop-grid">
            {cells.map((d, i) => d ? (
              <button
                key={i}
                type="button"
                className={`a-date-pop-day${sameDay(d, selected) ? " is-selected" : ""}${sameDay(d, cursor) ? " is-cursor" : ""}${sameDay(d, today) ? " is-today" : ""}`}
                onClick={() => commit(d)}
              >{d.getDate()}</button>
            ) : <span key={i} className="a-date-pop-empty" />)}
          </div>
        </div>,
        document.querySelector(".dir-a-root") || document.body
      )}
    </span>
  );
};
