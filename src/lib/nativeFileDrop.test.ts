import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
  onScaleChanged: vi.fn(),
  scaleFactor: vi.fn(),
  showTranslatedErrorToast: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mocks.onDragDropEvent,
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onScaleChanged: mocks.onScaleChanged,
    scaleFactor: mocks.scaleFactor,
  }),
}));

vi.mock("./operationToasts", () => ({
  showTranslatedErrorToast: mocks.showTranslatedErrorToast,
}));

import {
  resolveNativeDropScaleFactor,
  useNativeFileDropBridge,
} from "./nativeFileDrop";

function NativeDropBridgeHarness() {
  useNativeFileDropBridge();
  return null;
}

describe("resolveNativeDropScaleFactor", () => {
  it("accepts positive monitor scale changes", () => {
    expect(resolveNativeDropScaleFactor(1.5, 1)).toBe(1.5);
    expect(resolveNativeDropScaleFactor(2, 1.5)).toBe(2);
  });

  it("retains the last usable scale for invalid events", () => {
    expect(resolveNativeDropScaleFactor(0, 1.5)).toBe(1.5);
    expect(resolveNativeDropScaleFactor(Number.NaN, 2)).toBe(2);
  });
});

describe("useNativeFileDropBridge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scaleFactor.mockResolvedValue(1);
    mocks.onScaleChanged.mockResolvedValue(() => {});
    mocks.onDragDropEvent.mockResolvedValue(() => {});
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("surfaces failure to register the desktop drop listener", async () => {
    const error = new Error("drag capability denied");
    mocks.onDragDropEvent.mockRejectedValueOnce(error);

    await act(async () => {
      root.render(createElement(NativeDropBridgeHarness));
      await Promise.resolve();
    });

    expect(mocks.showTranslatedErrorToast).toHaveBeenCalledWith(
      "toasts.files.dropListenerFailed",
      error,
    );
  });
});
