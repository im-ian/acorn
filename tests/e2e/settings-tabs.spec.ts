import { test, expect, pressHotkey } from "./support";

// Each Settings tab has a label / heading unique enough to anchor against.
// Asserting one element per tab is enough to catch "clicked tab N but
// content M still rendered" regressions without locking us into specific
// form widgets.
const TAB_MARKERS: Array<{
  tab: string;
  marker: { kind: "text"; pattern: RegExp } | { kind: "heading"; name: string };
}> = [
  { tab: "Terminal", marker: { kind: "text", pattern: /Font family/i } },
  { tab: "Agents", marker: { kind: "text", pattern: /which AI CLI acorn uses/i } },
  { tab: "Sessions", marker: { kind: "text", pattern: /Confirm before removing/i } },
  { tab: "Editor", marker: { kind: "text", pattern: /Editor command/i } },
  { tab: "Notifications", marker: { kind: "text", pattern: /System notifications/i } },
  { tab: "Storage", marker: { kind: "heading", name: "Reclaimable cache" } },
  { tab: "About", marker: { kind: "heading", name: "About Acorn" } },
];

test.describe("settings modal: tab content", () => {
  test("clicking each tab swaps the body content", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: /Settings/i });
    await expect(modal).toBeVisible();

    for (const { tab, marker } of TAB_MARKERS) {
      await modal.getByRole("button", { name: tab, exact: true }).click();
      const expected =
        marker.kind === "heading"
          ? modal.getByRole("heading", { name: marker.name })
          : modal.getByText(marker.pattern);
      await expect(
        expected,
        `Settings → ${tab} should reveal its content marker`,
      ).toBeVisible();
    }
  });
});
