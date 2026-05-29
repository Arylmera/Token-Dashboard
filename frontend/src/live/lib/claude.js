/** Run a prompt; `onEvent` fires for every streamed event. Resolves once spawn returns. */
export async function runClaude(runId, prompt, onEvent, opts) {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const channel = new Channel();
  channel.onmessage = onEvent;
  await invoke("run_claude", {
    runId,
    prompt,
    cwd: opts?.cwd,
    model: opts?.model,
    resumeId: opts?.resumeId,
    onEvent: channel,
  });
}

/** Kill an in-flight run by its run id. */
export async function stopClaude(runId) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("stop_claude", { runId });
}
