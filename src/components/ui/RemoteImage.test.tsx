import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  imageSourceKind,
  MAX_DATA_IMAGE_SOURCE_BYTES,
  RemoteImage,
} from "./RemoteImage";

describe("RemoteImage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("waits for approval before assigning a remote source", () => {
    act(() => {
      root.render(
        <RemoteImage
          src="https://tracker.example/pixel.png"
          srcSet="https://tracker.example/pixel@2x.png 2x"
          alt="Build result"
        />,
      );
    });

    expect(container.querySelector("img")).toBeNull();
    const load = container.querySelector<HTMLButtonElement>(
      "[data-remote-image-placeholder]",
    );
    expect(load).not.toBeNull();
    expect(load?.textContent).toContain("tracker.example");

    act(() => load!.click());

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://tracker.example/pixel.png",
    );
    expect(image?.getAttribute("srcset")).toBeNull();
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("requires fresh approval when the remote source changes", () => {
    act(() => {
      root.render(<RemoteImage src="https://one.example/image.png" />);
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>("[data-remote-image-placeholder]")!
        .click();
    });
    expect(container.querySelector("img")).not.toBeNull();

    act(() => {
      root.render(<RemoteImage src="https://two.example/image.png" />);
    });

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-remote-image-placeholder]"),
    ).not.toBeNull();
  });

  it.each([
    "/images/local.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:https://example.com/8a3e3c30-7ad9-4bf6-ae6f-26f48d71ec29",
    "asset://localhost/background.png",
    "http://asset.localhost/background.png",
  ])("renders the safe local source %s immediately", (src) => {
    act(() => {
      root.render(<RemoteImage src={src} alt="Local image" />);
    });

    expect(
      container.querySelector("[data-remote-image-placeholder]"),
    ).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ])("does not render the unsafe source %s", (src) => {
    act(() => {
      root.render(<RemoteImage src={src} alt="Unsafe image" />);
    });

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-remote-image-placeholder]"),
    ).toBeNull();
    expect(container.textContent).toBe("Unsafe image");
  });

  it("does not render an oversized raster data source", () => {
    const prefix = "data:image/png;base64,";
    const src =
      prefix + "A".repeat(MAX_DATA_IMAGE_SOURCE_BYTES - prefix.length + 1);
    act(() => {
      root.render(<RemoteImage src={src} alt="Oversized image" />);
    });

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-remote-image-placeholder]"),
    ).toBeNull();
    expect(container.textContent).toBe("Oversized image");
  });

  it("measures raster data sources in bytes rather than UTF-16 units", () => {
    const prefix = "data:image/png,";
    const unicodePayload = "가".repeat(
      Math.floor(MAX_DATA_IMAGE_SOURCE_BYTES / 3) + 1,
    );

    expect((prefix + unicodePayload).length).toBeLessThan(
      MAX_DATA_IMAGE_SOURCE_BYTES,
    );
    expect(imageSourceKind(prefix + unicodePayload)).toBe("unsafe");
  });

  it("keeps relative and same-document Tauri image URLs local", () => {
    const base = document.createElement("base");
    base.href = "tauri://localhost/";
    document.head.appendChild(base);

    try {
      expect(imageSourceKind("docs/screenshot.png")).toBe("local");
      expect(imageSourceKind("/docs/screenshot.png")).toBe("local");
      expect(imageSourceKind("tauri://localhost/docs/screenshot.png")).toBe(
        "local",
      );
      expect(imageSourceKind("tauri://other/docs/screenshot.png")).toBe(
        "unsafe",
      );
    } finally {
      base.remove();
    }
  });

  it("does not treat authority URLs or alternate asset ports as local", () => {
    expect(imageSourceKind("//tracker.example/pixel.png")).toBe("remote");
    expect(imageSourceKind(String.raw`\\tracker.example\pixel.png`)).toBe(
      "remote",
    );
    expect(imageSourceKind("http://asset.localhost:8080/pixel.png")).toBe(
      "remote",
    );
  });

  it.each([
    "h\nttps://tracker.example/pixel.png",
    "ht\ttps://tracker.example/pixel.png",
    "http\r://tracker.example/pixel.png",
    "d\nata:image/png;base64,iVBORw0KGgo=",
  ])("rejects a URL containing parser-stripped controls: %j", (src) => {
    expect(imageSourceKind(src)).toBe("unsafe");
  });
});
