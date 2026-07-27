function isStorageLike(value: unknown): value is Storage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Storage).clear === "function" &&
    typeof (value as Storage).getItem === "function" &&
    typeof (value as Storage).setItem === "function" &&
    typeof (value as Storage).removeItem === "function"
  );
}

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

const storage = isStorageLike(globalThis.localStorage)
  ? globalThis.localStorage
  : createMemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
  writable: true,
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

// jsdom ships no ResizeObserver, and react-resizable-panels v4 constructs one
// unconditionally when a Group mounts. Nothing under test asserts on resize
// behaviour — jsdom reports zero-size elements anyway — so a no-op observer is
// enough to let those components mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: NoopResizeObserver,
    configurable: true,
    writable: true,
  });
}
