import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettingsRecord } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    getProjectSettings: vi.fn<() => Promise<ProjectSettingsRecord>>(),
    updateProjectSettings: vi.fn<
      (
        repoPath: string,
        settings: ProjectSettingsRecord["settings"],
      ) => Promise<ProjectSettingsRecord>
    >(),
  },
}));

import { api } from "../lib/api";
import { ProjectSettingsModal } from "./ProjectSettingsModal";

const mockApi = vi.mocked(api);

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function changeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProjectSettingsModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.getProjectSettings.mockReset();
    mockApi.updateProjectSettings.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads and saves project pull request settings", async () => {
    mockApi.getProjectSettings.mockResolvedValueOnce({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt: "Use concise release-note style.",
        },
      },
    });
    mockApi.updateProjectSettings.mockImplementation(
      async (_repoPath, settings) => ({
        key: "github:im-ian/acorn",
        settings,
      }),
    );
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={onClose}
        />,
      );
    });
    await flushPromises();

    const prompt = document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(prompt?.value).toBe("Use concise release-note style.");

    await act(async () => {
      changeTextareaValue(prompt!, "Write Korean release notes.");
    });

    const keepCheckbox = document.body.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(keepCheckbox?.checked).toBe(true);
    await act(async () => {
      keepCheckbox!.click();
    });

    const save = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Save");
    expect(save).toBeDefined();

    await act(async () => {
      save!.click();
    });
    await flushPromises();

    expect(mockApi.updateProjectSettings).toHaveBeenCalledWith("/repo/acorn", {
      remember_after_close: false,
      pull_requests: {
        generation_prompt: "Write Korean release notes.",
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the standard PR prompt while project settings are loading", async () => {
    mockApi.getProjectSettings.mockImplementation(
      () => new Promise<ProjectSettingsRecord>(() => {}),
    );

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={() => {}}
        />,
      );
    });

    const prompt = document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(prompt?.value).toContain("GitHub-style pull request");
  });
});
