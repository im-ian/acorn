type TrackerChangeListener = () => void;

const listeners = new Set<TrackerChangeListener>();

export function onTrackerAccountsChanged(
  listener: TrackerChangeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitTrackerAccountsChanged(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}
