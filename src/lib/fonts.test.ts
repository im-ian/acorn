import { describe, expect, it } from "vitest";
import {
  CURATED_MONOSPACE_FONTS,
  fontStackFromSlots,
  fontSlotsFromStack,
  fontFamilyOptions,
  sanitizeFontFamilyName,
} from "./fonts";

describe("CURATED_MONOSPACE_FONTS", () => {
  it("ships exactly 10 entries in stable order", () => {
    expect(CURATED_MONOSPACE_FONTS).toEqual([
      "JetBrains Mono",
      "Fira Code",
      "Cascadia Code",
      "SF Mono",
      "Menlo",
      "Monaco",
      "Consolas",
      "IBM Plex Mono",
      "Source Code Pro",
      "Hack",
    ]);
  });
});

describe("fontStackFromSlots", () => {
  it("quotes multi-word families and leaves single-word ones bare", () => {
    expect(
      fontStackFromSlots(["JetBrains Mono", "SF Mono", "Menlo"], "monospace"),
    ).toBe('"JetBrains Mono", "SF Mono", Menlo, monospace');
  });

  it("keeps custom font names and escapes quotes", () => {
    expect(
      fontStackFromSlots(['Berkeley "Mono"', "CommitMono", null], "monospace"),
    ).toBe('"Berkeley \\"Mono\\"", CommitMono, monospace');
  });

  it("skips null/empty slots and appends generic fallback", () => {
    expect(fontStackFromSlots(["Menlo", null, null], "monospace")).toBe(
      "Menlo, monospace",
    );
  });

  it("returns just the fallback when every slot is empty", () => {
    expect(fontStackFromSlots([null, null, null], "monospace")).toBe(
      "monospace",
    );
  });
});

describe("sanitizeFontFamilyName", () => {
  it("accepts custom system font names", () => {
    expect(sanitizeFontFamilyName("  Berkeley Mono  ")).toBe("Berkeley Mono");
  });

  it("rejects comma-separated stacks and generic fallbacks", () => {
    expect(sanitizeFontFamilyName("A, B")).toBeNull();
    expect(sanitizeFontFamilyName("monospace")).toBeNull();
  });
});

describe("fontFamilyOptions", () => {
  it("collapses weight and style variants into one family option", () => {
    expect(
      fontFamilyOptions(
        [
          "Berkeley Mono Regular",
          "Berkeley Mono Bold",
          "Berkeley Mono Medium Italic",
          "Alpha Sans Bold",
        ],
        "all",
      ),
    ).toEqual(["Alpha Sans", "Berkeley Mono"]);
  });

  it("can limit suggestions to likely monospace families", () => {
    expect(
      fontFamilyOptions(
        ["Alpha Sans", "Alpha Mono", "Consolas", "Fira Code"],
        "mono",
      ),
    ).toEqual(["Alpha Mono", "Consolas", "Fira Code"]);
  });
});

describe("fontSlotsFromStack", () => {
  it("round-trips three quoted families", () => {
    expect(
      fontSlotsFromStack('"JetBrains Mono", "SF Mono", Menlo, monospace'),
    ).toEqual(["JetBrains Mono", "SF Mono", "Menlo"]);
  });

  it("drops the trailing generic fallback", () => {
    expect(fontSlotsFromStack("Menlo, Monaco, Consolas, monospace")).toEqual([
      "Menlo",
      "Monaco",
      "Consolas",
    ]);
  });

  it("truncates to three slots", () => {
    expect(fontSlotsFromStack("A, B, C, D, monospace")).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("returns an empty array for a bare generic fallback", () => {
    expect(fontSlotsFromStack("monospace")).toEqual([]);
  });
});
