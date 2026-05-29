import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage stub for Node environment
const KEY = "praetorium.vaultPath";

function makeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

// Install stub before any module is loaded
globalThis.localStorage = makeLocalStorage();

const { vaultPathStore, setVaultPath } = await import("./vault-store.js");

test("vaultStore: defaults to empty string when unset", () => {
  assert.equal(vaultPathStore.get(), "");
});

test("vaultStore: setVaultPath updates the store", () => {
  setVaultPath("E:\\vault");
  assert.equal(vaultPathStore.get(), "E:\\vault");
});

test("vaultStore: setVaultPath persists to localStorage (round-trip)", () => {
  setVaultPath("D:\\notes");
  assert.equal(localStorage.getItem(KEY), "D:\\notes");
  assert.equal(vaultPathStore.get(), "D:\\notes");
});

test("vaultStore: setVaultPath with empty string clears", () => {
  setVaultPath("something");
  setVaultPath("");
  assert.equal(vaultPathStore.get(), "");
  assert.equal(localStorage.getItem(KEY), "");
});
