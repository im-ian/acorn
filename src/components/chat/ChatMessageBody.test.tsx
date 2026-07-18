import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { ChatMessageBody } from "./ChatMessageBody";

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ChatMessageBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("preserves paragraph and fenced code block order", async () => {
    await act(async () => {
      root.render(
        <ChatMessageBody
          content={"Before\n\n```ts\nconst answer = 42;\n```\n\nAfter"}
        />,
      );
    });
    await settle();

    const text = container.textContent ?? "";
    expect(text.indexOf("Before")).toBeLessThan(text.indexOf("const answer"));
    expect(text.indexOf("const answer")).toBeLessThan(text.indexOf("After"));
    expect(container.querySelector("[data-chat-code-block]")).toBeTruthy();
  });

  it("distinguishes inline code from fenced code blocks", async () => {
    await act(async () => {
      root.render(
        <ChatMessageBody
          content={"Use `inlineValue` here.\n\n```ts\nconst blockValue = true;\n```"}
        />,
      );
    });
    await settle();

    const inline = container.querySelector("[data-chat-inline-code]");
    const block = container.querySelector("[data-chat-code-block]");
    expect(inline?.textContent).toBe("inlineValue");
    expect(block?.textContent).toContain("blockValue");
  });

  it("shows the language label for fenced code", async () => {
    await act(async () => {
      root.render(
        <ChatMessageBody content={"```tsx\nexport function App() {}\n```"} />,
      );
    });
    await settle();

    expect(
      container.querySelector('[data-chat-code-block][data-language="tsx"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain("tsx");
  });

  it("copies the original fenced code text", async () => {
    await act(async () => {
      root.render(
        <ChatMessageBody content={"```ts\nconst copied = true;\n```"} />,
      );
    });
    await settle();

    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code block"]',
    );
    expect(copy).toBeTruthy();

    await act(async () => {
      copy!.click();
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "const copied = true;",
    );
  });

  it("renders diff fences with diff-specific rows", async () => {
    await act(async () => {
      root.render(
        <ChatMessageBody
          content={"```diff\n@@ -1 +1 @@\n-old line\n+new line\n```"}
        />,
      );
    });
    await settle();

    expect(container.querySelector("[data-chat-diff-block]")).toBeTruthy();
    expect(container.querySelector("[data-chat-diff-lines]")).toBeTruthy();
    expect(container.textContent).toContain("+new line");
    expect(container.textContent).toContain("-old line");
  });

  it("renders an unclosed streaming fence without breaking the message", async () => {
    await act(async () => {
      root.render(
        <ChatMessageBody
          content={"Before\n\n```ts\nconst partial = true;"}
          isStreaming
        />,
      );
    });
    await settle();

    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("const partial");
    expect(container.querySelector("[data-chat-code-block]")).toBeTruthy();
  });

  it("waits for approval before loading a remote Markdown image", () => {
    act(() => {
      root.render(
        <ChatMessageBody
          content={"![Remote build](https://tracker.example/build.png)"}
        />,
      );
    });

    expect(container.querySelector("img")).toBeNull();
    const load = container.querySelector<HTMLButtonElement>(
      "[data-remote-image-placeholder]",
    );
    expect(load).not.toBeNull();

    act(() => load!.click());

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://tracker.example/build.png",
    );
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

});
