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

/**
 * Slice a (sorted) row array into pages and expose nav state. Pairs with
 * <PageNav /> for the footer. Pages reset to 0 whenever the input length
 * or pageSize changes — that's what users want when they re-sort or
 * switch tabs and a previously-selected page no longer exists.
 */
export const usePaginated = (rows, pageSize = 20) => {
  const [page, setPage] = useState(0);
  const total = rows ? rows.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const slice = useMemo(() => {
    if (!rows) return [];
    return rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  }, [rows, safePage, pageSize]);
  return { slice, page: safePage, setPage, totalPages, total, pageSize };
};

export const PageNav = ({ page, setPage, totalPages, total, pageSize }) => {
  if (totalPages <= 1) return null;
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="a-page-nav">
      <button
        type="button"
        className="a-page-btn"
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        ‹ prev
      </button>
      <span className="a-page-status">
        {start}–{end} of {total} · page {page + 1} / {totalPages}
      </span>
      <button
        type="button"
        className="a-page-btn"
        disabled={page >= totalPages - 1}
        onClick={() => setPage(page + 1)}
      >
        next ›
      </button>
    </div>
  );
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
