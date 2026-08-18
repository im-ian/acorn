import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorAvatar } from "./AuthorAvatar";

describe("AuthorAvatar", () => {
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

  it("uses a size-adjusted GitHub avatar URL without a referrer", () => {
    act(() => {
      root.render(
        <AuthorAvatar
          login="octocat"
          avatarUrl="https://avatars.githubusercontent.com/u/583231?v=4"
          size={28}
        />,
      );
    });

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4&s=56",
    );
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it.each([
    "https://tracker.example/avatar.png",
    "http://avatars.githubusercontent.com/u/1",
    "https://user@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com:444/u/1",
    "javascript:alert(1)",
  ])("falls back instead of auto-loading an untrusted avatar URL: %s", (avatarUrl) => {
    act(() => {
      root.render(
        <AuthorAvatar login="octocat" avatarUrl={avatarUrl} size={24} />,
      );
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://github.com/octocat.png?size=48",
    );
  });
});
