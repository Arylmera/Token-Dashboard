import React, { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { vaultPathStore } from "../../stores/vault-store.js";
import { useStore } from "../../stores/use-store.js";
import { groupByLocation, relativeTime } from "../../lib/sessionGroup.js";

const turnClass = (role) => role === "user" ? "pr-turn user" : role === "tool" ? "pr-turn tool" : "pr-turn";
const shortLoc = (loc) => loc.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") || loc;

export function Sessions() {
  const vaultPath = useStore(vaultPathStore);
  const [sessions, setSessions] = useState(null);
  const [turns, setTurns] = useState([]);
  const [err, setErr] = useState("");
  const [activeIdSel, setActiveIdSel] = useState("");
  const [openSet, setOpenSet] = useState(new Set());

  // Load sessions on mount
  React.useEffect(() => {
    invoke("list_all_sessions")
      .then((list) => setSessions(list))
      .catch(() => setSessions([]));
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
    <div className="pr-sessions-pane">
      <aside className="pr-sess-list">
        <div className="pr-sessions-head">
          <span className="pr-sessions-title">TRANSCRIPTS</span>
          <span className="pr-sessions-sub">
            archive · {sessions?.length ?? 0} sessions · {groups.length} locations
          </span>
        </div>
        <div className="pr-sess-scroll">
          {groups.map(([loc, items]) => (
            <div key={loc} className="pr-sess-group">
              <div
                className={["pr-sess-loc", isCurrentVault(loc) && "is-current"].filter(Boolean).join(" ")}
                onClick={() => toggle(loc)}
                title={loc}
              >
                <span className="pr-folder-chevron">{isOpen(loc) ? "▾" : "▸"}</span>
                <span className="pr-sess-loc-name">{shortLoc(loc)}</span>
                <span className="pr-folder-count">{items.length}</span>
                <span className="pr-sess-loc-time">{relativeTime(items[0].mtimeMs)}</span>
              </div>
              {isOpen(loc) && (
                items.map((s) => (
                  <div
                    key={s.id}
                    className={["pr-sess-row", s.id === activeIdSel && "is-active"].filter(Boolean).join(" ")}
                    onClick={() => openSession(s)}
                  >
                    <span className="pr-sess-title">{s.title}</span>
                    <span className="pr-sess-meta"><span>{relativeTime(s.mtimeMs)}</span></span>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      </aside>
      <section className="pr-transcript">
        {err ? (
          <pre style={{ color: "var(--bad)" }}>{err}</pre>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={turnClass(t.role)}>
              <div className="role"><span className="tag">{t.role}</span></div>
              <pre>{t.text}</pre>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
