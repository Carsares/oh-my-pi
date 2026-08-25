// ABOUTME: Vitest global setup — injects localStorage/sessionStorage into the jsdom env.
// ABOUTME: vitest's jsdom runs on about:blank, which omits Web Storage; tests calling clear()/getItem() crash without this.

import { beforeEach } from "vitest";

/**
 * Minimal Web Storage implementation backed by a Map.
 * Provides the full Storage surface (getItem/setItem/removeItem/clear/key/length)
 * so any test that treats it as a real localStorage works without per-file stubs.
 */
function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const localStorageImpl = createMemoryStorage();
const sessionStorageImpl = createMemoryStorage();

function hasStorageMethods(value) {
  return (
    value &&
    typeof value.getItem === "function" &&
    typeof value.setItem === "function" &&
    typeof value.removeItem === "function" &&
    typeof value.clear === "function"
  );
}

// Node 25 exposes an incomplete storage placeholder when Vitest passes an
// invalid `--localstorage-file`; treat it like missing storage. Configurable+
// writable keeps individual tests free to vi.stubGlobal their own storage.
if (!hasStorageMethods(globalThis.localStorage)) {
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageImpl,
    configurable: true,
    writable: true,
  });
}
if (!hasStorageMethods(globalThis.sessionStorage)) {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: sessionStorageImpl,
    configurable: true,
    writable: true,
  });
}

// Reset between tests so state never leaks across files or cases. Tests that
// stub their own storage are unaffected — this only clears the shared impl.
beforeEach(() => {
  localStorageImpl.clear();
  sessionStorageImpl.clear();
});
