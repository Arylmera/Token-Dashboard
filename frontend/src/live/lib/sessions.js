export async function listLiveSessions() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("list_live_sessions");
  } catch { return []; }
}

export async function watchSessions(onEvent) {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const ch = new Channel();
  ch.onmessage = onEvent;
  await invoke("watch_sessions", { onEvent: ch });
}

export async function appCwd() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("app_cwd")) ?? undefined;
  } catch { return undefined; }
}
