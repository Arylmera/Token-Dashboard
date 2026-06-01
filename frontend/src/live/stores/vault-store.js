import { createStore } from "./create-store.js";

const KEY = "praetorium.vaultPath";

// A previously saved path always wins. Otherwise we start empty and let
// initVaultPath() resolve the Claude transcripts dir (~/.claude/projects)
// from the backend so the Explorer works with zero manual configuration.
export const vaultPathStore = createStore(localStorage.getItem(KEY) || "");

/** Single source of truth for the vault root. Updates the store and persists. */
export function setVaultPath(path) {
  localStorage.setItem(KEY, path);
  vaultPathStore.set(path);
}

/**
 * Derive the `~/.claude/projects` root from an absolute project dir such as
 * `C:\Users\me\.claude\projects\<slug>` (Windows) or
 * `/home/me/.claude/projects/<slug>` (unix). Returns "" when the marker is
 * absent so callers can fall back.
 */
export function projectsRootFrom(projectDir) {
  if (!projectDir) return "";
  const norm = projectDir.replace(/\\/g, "/");
  const marker = "/.claude/projects/";
  const i = norm.indexOf(marker);
  if (i === -1) {
    // projectDir may already BE the root, or end with the marker.
    return norm.replace(/\/+$/, "").endsWith("/.claude/projects")
      ? projectDir
      : "";
  }
  // Preserve the original separators of the source string.
  const cut = i + marker.length - 1; // keep up to ".../projects"
  return projectDir.slice(0, cut);
}

let initPromise = null;

/**
 * Seed vaultPathStore with the Claude transcripts dir when no path is saved.
 * Idempotent: a saved localStorage value or an earlier successful resolve
 * short-circuits. Safe to call on module load and again from components.
 */
export function initVaultPath() {
  if (vaultPathStore.get()) return Promise.resolve(vaultPathStore.get());
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (vaultPathStore.get()) return vaultPathStore.get();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Every session's projectDir lives under ~/.claude/projects/<slug>.
      const sessions = await invoke("list_all_sessions");
      for (const s of sessions ?? []) {
        const root = projectsRootFrom(s && s.projectDir);
        if (root) {
          // Resolved, but do NOT persist: we want the default to keep
          // tracking the real projects dir, and an explicit user choice
          // (setVaultPath) should still be able to override it later.
          if (!vaultPathStore.get()) vaultPathStore.set(root);
          return root;
        }
      }
    } catch {
      /* not in a Tauri context, or no sessions — leave empty, UI shows a state */
    }
    return vaultPathStore.get();
  })();

  return initPromise;
}

// Kick off resolution as soon as the module loads so the Explorer panes have a
// vault by the time they mount. Components also call initVaultPath() defensively.
initVaultPath();
