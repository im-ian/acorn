import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fsReveal: vi.fn<(path: string) => Promise<void>>(),
  showTranslatedErrorToast: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { fsReveal: mocks.fsReveal },
}));

vi.mock("./operationToasts", () => ({
  showTranslatedErrorToast: mocks.showTranslatedErrorToast,
}));

import {
  revealInFileManagerText,
  revealPathWithFeedback,
} from "./fileManager";
import { createTranslator } from "./i18n";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fsReveal.mockResolvedValue(undefined);
});

describe("revealInFileManagerText", () => {
  const t = createTranslator("en");

  it("uses Finder terminology on macOS", () => {
    expect(revealInFileManagerText(t, "MacIntel")).toBe("Reveal in Finder");
  });

  it("uses platform-neutral terminology outside macOS", () => {
    expect(revealInFileManagerText(t, "Win32")).toBe(
      "Reveal in File Manager",
    );
    expect(revealInFileManagerText(t, "Linux x86_64")).toBe(
      "Reveal in File Manager",
    );
  });
});

describe("revealPathWithFeedback", () => {
  it("reports success without an error toast", async () => {
    await expect(revealPathWithFeedback("/tmp/project")).resolves.toBe(true);

    expect(mocks.fsReveal).toHaveBeenCalledWith("/tmp/project");
    expect(mocks.showTranslatedErrorToast).not.toHaveBeenCalled();
  });

  it("surfaces authorization and launcher failures", async () => {
    const error = new Error("permission denied");
    mocks.fsReveal.mockRejectedValueOnce(error);

    await expect(revealPathWithFeedback("/private/project")).resolves.toBe(
      false,
    );
    expect(mocks.showTranslatedErrorToast).toHaveBeenCalledWith(
      "toasts.files.revealFailed",
      error,
    );
  });
});
