import { describe, expect, it } from "vitest";
import { revealInFileManagerText } from "./fileManager";
import { createTranslator } from "./i18n";

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
