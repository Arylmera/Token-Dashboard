import React, { useState, useMemo, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { resolveWikilinks } from "../../lib/wikilinks.js";
import { buildLinkMaps } from "../../lib/vaultLinks.js";
import { vaultPathStore } from "../../stores/vault-store.js";
import { pendingNoteStore, clearPendingNote } from "../../stores/explorer-store.js";
import { useStore } from "../../stores/use-store.js";
import { buildTree, flattenVisible } from "../../lib/fileTree.js";

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

  // Load files and links whenever vaultPath changes.
  useEffect(() => {
    setActiveRel(""); setHtml(""); setErr(""); setExpanded(new Set());
    if (!vaultPath) { setFiles([]); setLinks([]); return; }
    invoke("vault_index", { vaultPath }).then(setFiles).catch(() => setFiles([]));
    invoke("vault_links", { vaultPath }).then(setLinks).catch(() => setLinks([]));
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
    <div className="pr-files-grid">
      <aside className="pr-files-list">
        <div className="pr-files-search">
          <input
            className="pr-search-input"
            placeholder="grep vault…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
          <div className="pr-sort" role="group" aria-label="Sort">
            <button className={sort === "name" ? "is-active" : ""} onClick={() => setSort("name")}>name</button>
            <button className={sort === "modified" ? "is-active" : ""} onClick={() => setSort("modified")}>mod</button>
            <button className={sort === "size" ? "is-active" : ""} onClick={() => setSort("size")}>size</button>
          </div>
        </div>
        <div className="pr-files-scroll">
          {rows.map((r) =>
            r.kind === "folder" ? (
              <div
                key={r.id}
                className="pr-folder"
                style={{ paddingLeft: `${8 + r.depth * 14}px` }}
                onClick={() => toggle(r.id)}
              >
                <span className="pr-folder-chevron">{expanded.has(r.id) || q ? "▾" : "▸"}</span>
                <span className="pr-folder-name">{r.name}</span>
                <span className="pr-folder-count">{r.count}</span>
              </div>
            ) : (
              <div
                key={r.id}
                className={["pr-file", r.id === activeRel && "is-active"].filter(Boolean).join(" ")}
                style={{ paddingLeft: `${8 + r.depth * 14}px` }}
                onClick={() => openNote(r.id)}
                title={r.id}
              >
                <span>{r.name}</span>
                <span className="pr-file-tail">
                  {isOrphan(r.id) && <span className="pr-orphan" title="no links in or out">○</span>}
                  {sizeByRel.get(r.id) ? (
                    <span className="size">{(sizeByRel.get(r.id) / 1024).toFixed(1)}k</span>
                  ) : null}
                </span>
              </div>
            )
          )}
        </div>
      </aside>
      <article className="pr-doc" onClick={onContentClick}>
        {err ? (
          <pre style={{ color: "var(--bad)" }}>{err}</pre>
        ) : html ? (
          <>
            <nav className="pr-breadcrumb">
              {breadcrumb.map((seg, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="pr-crumb-sep">/</span>}
                  <span className="pr-crumb">{seg}</span>
                </React.Fragment>
              ))}
            </nav>
            <div className="pr-note-meta">
              <span>{wordCount} words</span>
              <span>{backlinks.length} backlinks</span>
              <span>{outlinks.length} links out</span>
            </div>
            <div dangerouslySetInnerHTML={{ __html: html }} />
            {activeRel && (
              <section className="pr-backlinks">
                <div className="pr-backlinks-head">Linked references</div>
                {backlinks.length ? (
                  <div className="pr-backlinks-list">
                    {backlinks.map((rel) => (
                      <span
                        key={rel}
                        className="pr-backlink"
                        onClick={() => openNote(rel)}
                        title={rel}
                      >
                        {nameByRel.get(rel) ?? rel}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="pr-backlinks-empty">No linked references.</div>
                )}
              </section>
            )}
          </>
        ) : (
          <p className="muted">Select a note to read it.</p>
        )}
      </article>
    </div>
  );
}
