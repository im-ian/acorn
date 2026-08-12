import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fsOpenDefault: vi.fn<(path: string) => Promise<void>>(),
  openInEditor: vi.fn<
    (command: string, args: string[], path: string) => Promise<void>
  >(),
  showTranslatedErrorToast: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    fsOpenDefault: mocks.fsOpenDefault,
    openInEditor: mocks.openInEditor,
  },
}));

vi.mock("./operationToasts", () => ({
  showTranslatedErrorToast: mocks.showTranslatedErrorToast,
}));

import {
  openFileInEditorWithFeedback,
  openInConfiguredEditorWithFeedback,
} from "./editor";
import { DEFAULT_SETTINGS, useSettings } from "./settings";

describe("editor launch feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fsOpenDefault.mockResolvedValue(undefined);
    mocks.openInEditor.mockResolvedValue(undefined);
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
  });

  it("reports default-editor success without an error toast", async () => {
    await expect(
      openFileInEditorWithFeedback("/tmp/project/readme.md"),
    ).resolves.toBe(true);

    expect(mocks.fsOpenDefault).toHaveBeenCalledWith(
      "/tmp/project/readme.md",
    );
    expect(mocks.showTranslatedErrorToast).not.toHaveBeenCalled();
  });

  it("surfaces configured-editor launch failures", async () => {
    useSettings.setState((state) => ({
      settings: {
        ...state.settings,
        editor: { command: "code --wait" },
      },
    }));
    const error = new Error("editor executable permission denied");
    mocks.openInEditor.mockRejectedValueOnce(error);

    await expect(
      openInConfiguredEditorWithFeedback("/private/project"),
    ).resolves.toBe(false);

    expect(mocks.openInEditor).toHaveBeenCalledWith(
      "code",
      ["--wait"],
      "/private/project",
    );
    expect(mocks.showTranslatedErrorToast).toHaveBeenCalledWith(
      "toasts.files.editorOpenFailed",
      error,
    );
  });

  it("keeps a missing editor configuration as a non-error no-op", async () => {
    await expect(
      openInConfiguredEditorWithFeedback("/tmp/project"),
    ).resolves.toBe(false);

    expect(mocks.openInEditor).not.toHaveBeenCalled();
    expect(mocks.showTranslatedErrorToast).not.toHaveBeenCalled();
  });
});
