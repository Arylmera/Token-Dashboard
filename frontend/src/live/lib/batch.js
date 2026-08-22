// Collapses a burst of items into a single flush per scheduled tick. The Live
// watcher emits one event per appended transcript line; without this, every
// line triggers its own store commit and therefore its own React render.
export function createBatcher(flush, schedule = queueMicrotask) {
  let queue = [];
  let scheduled = false;
  return (item) => {
    queue.push(item);
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      const batch = queue;
      // Reset BEFORE flushing so a throwing flush cannot wedge the batcher.
      queue = [];
      scheduled = false;
      flush(batch);
    });
  };
}
