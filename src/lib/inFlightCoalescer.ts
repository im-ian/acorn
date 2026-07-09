export function createInFlightCoalescer<T>(
  load: () => Promise<T>,
): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;
    inFlight = load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
