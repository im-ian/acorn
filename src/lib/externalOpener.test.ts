import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn<(url: string) => Promise<boolean>>(),
  showTranslatedErrorToast: vi.fn(),
  showTranslatedToast: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { openExternalUrl: mocks.openExternalUrl },
}));

vi.mock("./operationToasts", () => ({
  showTranslatedErrorToast: mocks.showTranslatedErrorToast,
  showTranslatedToast: mocks.showTranslatedToast,
}));

import { openExternalUrlWithFeedback } from "./externalOpener";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExternalUrl.mockResolvedValue(true);
});

describe("openExternalUrlWithFeedback", () => {
  it("opens a safe URL without a toast", async () => {
    await expect(
      openExternalUrlWithFeedback("https://example.com/acorn"),
    ).resolves.toBe(true);

    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://example.com/acorn",
    );
    expect(mocks.showTranslatedToast).not.toHaveBeenCalled();
    expect(mocks.showTranslatedErrorToast).not.toHaveBeenCalled();
  });

  it("surfaces launcher failures", async () => {
    const error = new Error("no application registered for https");
    mocks.openExternalUrl.mockRejectedValueOnce(error);

    await expect(
      openExternalUrlWithFeedback("https://example.com/acorn"),
    ).resolves.toBe(false);
    expect(mocks.showTranslatedErrorToast).toHaveBeenCalledWith(
      "toasts.opener.urlFailed",
      error,
    );
  });

  it("keeps the URL policy gate and never reaches the opener for unsafe input", async () => {
    await expect(
      openExternalUrlWithFeedback("javascript:alert(1)"),
    ).resolves.toBe(false);

    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
    expect(mocks.showTranslatedToast).toHaveBeenCalledWith(
      "toasts.opener.urlBlocked",
    );
  });

  it("reports a refusal from the backend policy check", async () => {
    mocks.openExternalUrl.mockResolvedValueOnce(false);

    await expect(
      openExternalUrlWithFeedback("https://example.com/acorn"),
    ).resolves.toBe(false);
    expect(mocks.showTranslatedToast).toHaveBeenCalledWith(
      "toasts.opener.urlBlocked",
    );
  });
});
