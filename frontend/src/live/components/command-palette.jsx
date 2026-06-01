import React, { useState, useMemo, useRef, useEffect } from "react";
import { buildCommands, filterCommands } from "../lib/commands.js";

export function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef(null);

  // Recomputed each keystroke; buildCommands reads the live session/theme signals.
  const results = useMemo(
    () => (open ? filterCommands(buildCommands(), query) : []),
    [open, query],
  );

  // Autofocus whenever the palette opens.
  useEffect(() => {
    if (open) {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = () => {
    onClose();
    setQuery("");
    setSelected(0);
  };

  const run = (cmd) => {
    if (!cmd) return;
    cmd.run();
    close();
  };

  const onKeyDown = (e) => {
    const list = results;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (list.length ? (i + 1) % list.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (list.length ? (i - 1 + list.length) % list.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(list[selected]);
    }
  };

  const onInput = (e) => {
    setQuery(e.currentTarget.value);
    setSelected(0);
  };

  // Group headers in render order; selection indexes the flat filtered list.
  const groups = useMemo(() => {
    const order = ["Navigate", "Session"];
    return order
      .map((g) => ({ group: g, items: results.filter((c) => c.group === g) }))
      .filter((s) => s.items.length > 0);
  }, [results]);

  const flatIndex = (cmd) => results.indexOf(cmd);

  if (!open) return null;

  return (
    <div className="pr-palette" onClick={close} onKeyDown={onKeyDown}>
      <div className="pr-palette-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="pr-palette-input"
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={onInput}
          spellCheck={false}
          autoComplete="off"
        />
        {results.length > 0 ? (
          <div className="pr-palette-list" role="listbox">
            {groups.map((section) => (
              <div key={section.group} className="pr-palette-group">
                <div className="pr-palette-group-label">{section.group}</div>
                {section.items.map((cmd) => {
                  const idx = flatIndex(cmd);
                  return (
                    <div
                      key={cmd.id}
                      className={["pr-palette-item", selected === idx && "is-selected"].filter(Boolean).join(" ")}
                      role="option"
                      aria-selected={selected === idx}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => run(cmd)}
                    >
                      <span className="pr-palette-item-title">{cmd.title}</span>
                      {cmd.hint && (
                        <span className="pr-palette-item-hint">{cmd.hint}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="pr-palette-empty">No matching commands.</div>
        )}
      </div>
    </div>
  );
}
