import { createStore } from "./create-store.js";

/* Global view state, lifted out of App.tsx so the Command Palette (and any
   other non-descendant) can navigate without prop drilling. */
export const viewStore = createStore("console");

export const setView = (v) => viewStore.set(v);
