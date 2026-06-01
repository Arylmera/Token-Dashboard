import React, { useState, useMemo, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { resolveWikilinks } from "../../lib/wikilinks.js";
import { buildLinkMaps } from "../../lib/vaultLinks.js";
import { vaultPathStore, initVaultPath } from "../../stores/vault-store.js";
import { pendingNoteStore, clearPendingNote } from "../../stores/explorer-store.js";
import { useStore } from "../../stores/use-store.js";
import { buildTree, flattenVisible } from "../../lib/fileTree.js";

const EMPTY_STYLE = { padding: "14px", color: "var(--gull)", font: "400 12.5px var(--font-mono)", lineHeight: 1.5 };
const ERR_STYLE = { padding: "14px", color: "var(--bad)", font: "400 12.5px var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap" };

export function Files() {
  const vaultPath = useStore(vaultPathStore);
  const pendingNote = useStore(pendingNoteStore);

  const [files, setFiles] = useState([]);
  const [links, setLinks] = useState([]);
  const [html, setHtml] = useState("");
  const [err, setErr] = useState("");
  const [activeRel, setActiveRel] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("name");
  // "expanded" = set of folder paths currently open in the tree
  const [expanded, setExpanded] = useState(new Set());

  const [listErr, setListErr] = useState("");

  // Resolve the default vault (~/.claude/projects) once on mount.
  useEffect(() => { initVaultPath(); }, []);

  // Load files and links whenever vaultPath changes.
  useEffect(() => {
    setActiveRel(""); setHtml(""); setErr(""); setExpanded(new Set());
    if (!vaultPath) { setFiles([]); setLinks([]); setListErr(""); return; }
    setListErr("");
    invoke("vault_index", { vaultPath })
      .then((res) => setFiles(res ?? []))
      .catch((e) => { setFiles([]); setListErr(String(e)); });
    invoke("vault_links", { vaultPath })
      .then((res) => setLinks(res ?? []))
      .catch(() => setLinks([]));
  }, [vaultPath]);

  const index = useMemo(
    () => new Map(files.map((f) => [f.name.toLowerCase(), f.rel])),
    [files],
  );
  const nameByRel = useMemo(
    () => new Map(files.map((f) => [f.rel, f.name])),
    [files],
  );
  const maps = useMemo(() => buildLinkMaps(links), [links]);
  const backlinks = useMemo(() => maps.backward.get(activeRel) ?? [], [maps, activeRel]);
  const outlinks = useMemo(() => maps.forward.get(activeRel) ?? [], [maps, activeRel]);
  const isOrphan = (rel) =>
    (maps.forward.get(rel)?.length ?? 0) === 0 && (maps.backward.get(rel)?.length ?? 0) === 0;

  const openNote = useCallback(async (rel) => {
    setErr(""); setActiveRel(rel);
    try {
      const md = await invoke("read_vault_file", { path: `${vaultPath}\\${rel.replace(/\//g, "\\")}` });
      setHtml(resolveWikilinks(await marked.parse(md), index));
    } catch (e) { setErr(String(e)); }
  }, [vaultPath, index]);

  // Map (or anything) requested a note: open it + expand its ancestor folders.
  useEffect(() => {
    if (!pendingNote) return;
    const segs = pendingNote.replace(/\\/g, "/").split("/"); segs.pop();
    setExpanded((prev) => {
      const next = new Set(prev); let acc = "";
      for (const s of segs) { acc = acc ? `${acc}/${s}` : s; next.add(acc); }
      return next;
    });
    openNote(pendingNote);
    clearPendingNote();
  }, [pendingNote, openNote]);

  function onContentClick(e) {
    const t = e.target;
    if (t.classList.contains("wikilink")) {
      e.preventDefault();
      const rel = t.getAttribute("data-rel");
      if (rel) openNote(rel);
    }
  }

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    if (!needle) return files;
    return files.filter((f) => f.name.toLowerCase().includes(needle) || f.rel.toLowerCase().includes(needle));
  }, [files, q]);

  // When searching, force-expand every folder so matches are visible.
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const rows = useMemo(() => {
    if (q) {
      const allFolders = new Set();
      const collect = (n) => { for (const sub of n.folders) { allFolders.add(sub.path); collect(sub); } };
      collect(tree);
      return flattenVisible(tree, allFolders);
    }
    return flattenVisible(tree, expanded);
  }, [tree, q, expanded]);

  function toggle(path) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  const sizeByRel = useMemo(
    () => new Map(files.map((f) => [f.rel, f.size ?? 0])),
    [files],
  );
  const wordCount = useMemo(() => {
    const text = html.replace(/<[^>]+>/g, " ");
    const m = text.match(/\S+/g);
    return m ? m.length : 0;
  }, [html]);
  const breadcrumb = activeRel.replace(/\\/g, "/").split("/");

  return (
    <div className="a-card-row" style={{ marginBottom: 0, alignItems: "stretch" }}>
      <section className="a-card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="a-card-head">
          <h2>Vault</h2>
          <span className="a-card-meta">{files.length} <span style={{ color: "var(--gull-2)" }}>notes</span></span>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "10px", flexWrap: "wrap" }}>
          <input
            className="a-text-input"
            placeholder="grep vault…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            style={{
              flex: "1 1 120px", minWidth: 0,
              background: "var(--panel-2)", color: "var(--bone)",
              border: "1px solid var(--iron-border)", borderRadius: "6px",
              padding: "5px 9px", font: "500 12px \"JetBrains Mono\"", outline: "none",
            }}
          />
          <div className="a-pill-btn-row" role="group" aria-label="Sort">
            <button className={["a-pill-btn", sort === "name" && "is-active"].filter(Boolean).join(" ")} onClick={() => setSort("name")}>name</button>
            <button className={["a-pill-btn", sort === "modified" && "is-active"].filter(Boolean).join(" ")} onClick={() => setSort("modified")}>mod</button>
            <button className={["a-pill-btn", sort === "size" && "is-active"].filter(Boolean).join(" ")} onClick={() => setSort("size")}>size</button>
          </div>
        </div>
        <div className="a-table-scroll" style={{ overflowY: "auto", flex: 1, minHeight: 0, maxHeight: "62vh" }}>
          {!vaultPath ? (
            <div style={EMPTY_STYLE}>Locating Claude vault…</div>
          ) : listErr ? (
            <div style={ERR_STYLE}>{listErr}</div>
          ) : rows.length === 0 ? (
            <div style={EMPTY_STYLE}>
              {q ? "No notes match your search." : "No vault content found."}
            </div>
          ) : null}
          {rows.length > 0 && (
            <table className="a-table">
              <tbody>
                {rows.map((r) =>
                  r.kind === "folder" ? (
                    <tr key={r.id} className="clickable" onClick={() => toggle(r.id)}>
                      <td colSpan={2} style={{ paddingLeft: `${8 + r.depth * 14}px` }}>
                        <span style={{ color: "var(--gull-2)", marginRight: "6px" }}>{expanded.has(r.id) || q ? "▾" : "▸"}</span>
                        <span style={{ color: "var(--bone)", fontWeight: 600 }}>{r.name}</span>
                        <span style={{ color: "var(--gull-2)", marginLeft: "6px", font: "500 10px \"JetBrains Mono\"" }}>{r.count}</span>
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={r.id}
                      className={["clickable", r.id === activeRel && "is-active"].filter(Boolean).join(" ")}
                      onClick={() => openNote(r.id)}
                      title={r.id}
                    >
                      <td style={{ paddingLeft: `${8 + r.depth * 14}px` }}>{r.name}</td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {isOrphan(r.id) && <span style={{ color: "var(--gull-2)", marginRight: "6px" }} title="no links in or out">○</span>}
                        {sizeByRel.get(r.id) ? (
                          <span style={{ color: "var(--gull)", font: "500 10px \"JetBrains Mono\"" }}>{(sizeByRel.get(r.id) / 1024).toFixed(1)}k</span>
                        ) : null}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <article className="a-card" onClick={onContentClick} style={{ overflowY: "auto", maxHeight: "calc(62vh + 60px)" }}>
        {err ? (
          <>
            <div className="a-card-head"><h2>Reader</h2></div>
            <pre className="a-pre" style={{ color: "var(--bad)" }}>{err}</pre>
          </>
        ) : html ? (
          <>
            <nav className="a-card-head" style={{ flexWrap: "wrap", gap: "2px" }}>
              <h2 style={{ display: "flex", alignItems: "center", gap: "2px", flexWrap: "wrap" }}>
                {breadcrumb.map((seg, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span style={{ color: "var(--gull-2)", margin: "0 4px" }}>/</span>}
                    <span style={{ color: i === breadcrumb.length - 1 ? "var(--bone)" : "var(--gull)" }}>{seg}</span>
                  </React.Fragment>
                ))}
              </h2>
              <span className="a-card-meta">
                {wordCount} words · {backlinks.length} backlinks · {outlinks.length} links out
              </span>
            </nav>
            <div dangerouslySetInnerHTML={{ __html: html }} />
            {activeRel && (
              <>
                <div className="a-card-divider" />
                <section>
                  <div className="a-card-meta" style={{ marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Linked references</div>
                  {backlinks.length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {backlinks.map((rel) => (
                        <span
                          key={rel}
                          onClick={() => openNote(rel)}
                          title={rel}
                          style={{
                            cursor: "pointer", padding: "3px 8px", borderRadius: "6px",
                            background: "var(--panel-2)", border: "1px solid var(--iron-border)",
                            color: "var(--accent)", font: "500 11px \"JetBrains Mono\"",
                          }}
                        >
                          {nameByRel.get(rel) ?? rel}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="a-card-meta">No linked references.</div>
                  )}
                </section>
              </>
            )}
          </>
        ) : (
          <>
            <div className="a-card-head"><h2>Reader</h2></div>
            <p className="a-card-meta">Select a note to read it.</p>
          </>
        )}
      </article>
    </div>
  );
}
