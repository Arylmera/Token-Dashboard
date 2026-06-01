import { createStore } from "./create-store.js";

export const subStore = createStore("files");
export const pendingNoteStore = createStore("");

export const setSub = (v) => subStore.set(v);

/** Switch to the Files sub-view and request that note be opened. */
export function openNote(rel) {
  pendingNoteStore.set(rel);
  subStore.set("files");
}

/** Files calls this once it has consumed a pending note, so the same note can
 *  be requested again later (stores only fire on value change). */
export function clearPendingNote() {
  pendingNoteStore.set("");
}
