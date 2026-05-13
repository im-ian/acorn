function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

function ensureStorage(target: typeof globalThis | Window): void {
  const current = target.localStorage;
  if (typeof current?.setItem === "function") return;
  Object.defineProperty(target, "localStorage", {
    value: makeStorage(),
    configurable: true,
  });
}

ensureStorage(globalThis);
if (typeof window !== "undefined") {
  ensureStorage(window);
}
