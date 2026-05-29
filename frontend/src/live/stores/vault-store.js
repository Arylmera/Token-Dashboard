import { createStore } from "./create-store.js";

const KEY = "praetorium.vaultPath";

export const vaultPathStore = createStore(localStorage.getItem(KEY) || "");

/** Single source of truth for the vault root. Updates the store and persists. */
export function setVaultPath(path) {
  localStorage.setItem(KEY, path);
  vaultPathStore.set(path);
}
