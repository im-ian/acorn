export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openPath(path: string): Promise<void> {
  console.info("[storybook] openPath", path);
}
