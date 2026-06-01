import { useSyncExternalStore } from "react";

export const useStore = (store) =>
  useSyncExternalStore(store.subscribe, store.get);
