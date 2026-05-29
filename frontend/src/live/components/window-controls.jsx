import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const win = () => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
};

export function WindowControls() {
  if (!isTauri) return null;
  return (
    <div className="pr-wincontrols">
      <button className="pr-winbtn" aria-label="Minimize" onClick={() => win()?.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button className="pr-winbtn" aria-label="Maximize" onClick={() => win()?.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button className="pr-winbtn pr-winbtn-close" aria-label="Close" onClick={() => win()?.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
