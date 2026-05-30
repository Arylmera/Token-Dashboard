import React, { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { vaultPathStore } from "../../stores/vault-store.js";
import { useStore } from "../../stores/use-store.js";
import { groupByLocation, relativeTime } from "../../lib/sessionGroup.js";

const shortLoc = (loc) => loc.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") || loc;

const EMPTY_STYLE = { padding: "14px", color: "var(--gull)", font: "400 12.5px var(--font-mono)", lineHeight: 1.5 };
const ERR_STYLE = { padding: "14px", color: "var(--bad)", font: "400 12.5px var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap" };

export function Sessions() {
  const vaultPath = useStore(vaultPathStore);
  const [sessions, setSessions] = useState(null);
  const [turns, setTurns] = useState([]);
  const [err, setErr] = useState("");
  const [listErr, setListErr] = useState("");
  const [activeIdSel, setActiveIdSel] = useState("");
  const [openSet, setOpenSet] = useState(new Set());

  // Load sessions on mount
  React.useEffect(() => {
    invoke("list_all_sessions")
      .then((list) => { setSessions(list ?? []); setListErr(""); })
      .catch((e) => { setSessions([]); setListErr(String(e)); });
  }, []);

  const groups = useMemo(() => groupByLocation(sessions ?? []), [sessions]);

  const isCurrentVault = (loc) =>
    !!vaultPath && loc.replace(/\\/g, "/") === vaultPath.replace(/\\/g, "/");

  // Open the current-vault group (and the newest group) by default once loaded.
  const ensureDefaults = useMemo(() => {
    const g = groups;
    if (!g.length) return new Set();
    const next = new Set([g[0][0]]);
    for (const [loc] of g) if (isCurrentVault(loc)) next.add(loc);
    return next;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, vaultPath]);

  function toggle(loc) {
    setOpenSet((prev) => {
      const base = prev.size ? prev : ensureDefaults;
      const next = new Set(base);
      next.has(loc) ? next.delete(loc) : next.add(loc);
      return next;
    });
  }

  const isOpen = (loc) => (openSet.size ? openSet : ensureDefaults).has(loc);

  async function openSession(s) {
    setErr(""); setActiveIdSel(s.id);
    try { setTurns(await invoke("read_session", { path: `${s.projectDir}\\${s.id}.jsonl` })); }
    catch (e) { setErr(String(e)); setTurns([]); }
  }

  return (
    <div className="a-card-row" style={{ marginBottom: 0, alignItems: "stretch" }}>
      <section className="a-card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="a-card-head">
          <h2>TRANSCRIPTS</h2>
          <span className="a-card-meta">
            archive · {sessions?.length ?? 0} sessions · {groups.length} locations
          </span>
        </div>
        <div className="a-table-scroll" style={{ overflowY: "auto", flex: 1, minHeight: 0, maxHeight: "62vh" }}>
          {sessions === null ? (
            <div style={EMPTY_STYLE}>Loading sessions…</div>
          ) : listErr ? (
            <div style={ERR_STYLE}>{listErr}</div>
          ) : groups.length === 0 ? (
            <div style={EMPTY_STYLE}>No Claude sessions found.</div>
          ) : null}
          {groups.length > 0 && (
            <table className="a-table">
              <tbody>
                {groups.map(([loc, items]) => (
                  <React.Fragment key={loc}>
                    <tr className="clickable" onClick={() => toggle(loc)} title={loc}>
                      <td colSpan={2}>
                        <span style={{ color: "var(--gull-2)", marginRight: "6px" }}>{isOpen(loc) ? "▾" : "▸"}</span>
                        <span style={{ color: isCurrentVault(loc) ? "var(--accent)" : "var(--bone)", fontWeight: 600 }}>{shortLoc(loc)}</span>
                        <span style={{ color: "var(--gull-2)", marginLeft: "6px", font: "500 10px \"JetBrains Mono\"" }}>{items.length}</span>
                        {isCurrentVault(loc) && (
                          <span style={{ color: "var(--accent)", marginLeft: "6px", font: "500 9.5px \"JetBrains Mono\"", letterSpacing: "0.04em" }}>· current</span>
                        )}
                      </td>
                      <td className="num" style={{ color: "var(--gull-2)", font: "500 10px \"JetBrains Mono\"", whiteSpace: "nowrap" }}>{relativeTime(items[0].mtimeMs)}</td>
                    </tr>
                    {isOpen(loc) &&
                      items.map((s) => (
                        <tr
                          key={s.id}
                          className={["clickable", s.id === activeIdSel && "is-active"].filter(Boolean).join(" ")}
                          onClick={() => openSession(s)}
                        >
                          <td colSpan={2} style={{ paddingLeft: "22px", color: "var(--bone)" }}>{s.title}</td>
                          <td className="num" style={{ color: "var(--gull)", font: "500 10px \"JetBrains Mono\"", whiteSpace: "nowrap" }}>{relativeTime(s.mtimeMs)}</td>
                        </tr>
                      ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <section className="a-card" style={{ overflowY: "auto", maxHeight: "calc(62vh + 60px)" }}>
        <div className="a-card-head">
          <h2>Transcript</h2>
          {turns.length > 0 && <span className="a-card-meta">{turns.length} <span style={{ color: "var(--gull-2)" }}>turns</span></span>}
        </div>
        {err ? (
          <pre className="a-pre" style={{ color: "var(--bad)" }}>{err}</pre>
        ) : turns.length === 0 ? (
          <p className="a-card-meta">Select a session to read its transcript.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {turns.map((t, i) => {
              const tone = t.role === "user" ? "var(--accent)" : t.role === "tool" ? "var(--warn)" : "var(--good)";
              return (
                <div
                  key={i}
                  style={{
                    border: "1px solid var(--iron-border)", borderLeft: `2px solid ${tone}`,
                    borderRadius: "6px", background: "var(--panel-2)", padding: "8px 10px",
                  }}
                >
                  <div style={{ marginBottom: "4px" }}>
                    <span style={{ color: tone, font: "600 10px \"JetBrains Mono\"", textTransform: "uppercase", letterSpacing: "0.06em" }}>{t.role}</span>
                  </div>
                  <pre className="a-pre" style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--bone)" }}>{t.text}</pre>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
