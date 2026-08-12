import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn<(text: string) => Promise<void>>(),
  showTranslatedErrorToast: vi.fn(),
}));

vi.mock("./clipboardText", () => ({
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("./operationToasts", () => ({
  showTranslatedErrorToast: mocks.showTranslatedErrorToast,
}));

import { copyTextWithFeedback } from "./clipboardActions";

describe("copyTextWithFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeClipboardText.mockResolvedValue(undefined);
  });

  it("reports success without showing an error toast", async () => {
    await expect(copyTextWithFeedback("copied text")).resolves.toBe(true);

    expect(mocks.writeClipboardText).toHaveBeenCalledWith("copied text");
    expect(mocks.showTranslatedErrorToast).not.toHaveBeenCalled();
  });

  it("surfaces clipboard permission failures and reports failure", async () => {
    const error = new Error("clipboard permission denied");
    mocks.writeClipboardText.mockRejectedValueOnce(error);

    await expect(copyTextWithFeedback("blocked text")).resolves.toBe(false);

    expect(mocks.showTranslatedErrorToast).toHaveBeenCalledWith(
      "toasts.clipboard.writeFailed",
      error,
    );
  });
});
