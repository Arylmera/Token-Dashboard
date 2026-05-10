import React, { useMemo, useState } from "react";

const cmp = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

export const useSortable = (rows, defaultKey = null, defaultDir = "desc", accessors = {}) => {
  const [state, setState] = useState({ key: defaultKey, dir: defaultDir });

  const requestSort = (key) => setState((s) => {
    if (s.key !== key) return { key, dir: "desc" };
    if (s.dir === "desc") return { key, dir: "asc" };
    return { key: null, dir: "desc" };
  });

  const sorted = useMemo(() => {
    if (!state.key) return rows;
    const get = accessors[state.key] || ((r) => r[state.key]);
    const sign = state.dir === "asc" ? 1 : -1;
    return [...(rows || [])].sort((a, b) => sign * cmp(get(a), get(b)));
  }, [rows, state.key, state.dir]);

  return { sorted, sortState: state, requestSort };
};

export const SortHeader = ({ sortKey, state, requestSort, className = "", children, style, title }) => {
  const active = state && state.key === sortKey;
  const dir = active ? state.dir : null;
  const cls = ["a-th-sort", className, active ? `is-sort-${dir}` : ""].filter(Boolean).join(" ");
  return (
    <th
      className={cls}
      style={style}
      onClick={() => requestSort(sortKey)}
      title={title || `sort by ${typeof children === "string" ? children : sortKey}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); requestSort(sortKey); } }}
    >
      {children}
      <span className="a-th-sort-ind" aria-hidden="true">
        {dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}
      </span>
    </th>
  );
};
