import { describe, expect, it } from "vitest";
import { isMissingPtyError } from "./ptyErrors";

describe("isMissingPtyError", () => {
  it("matches the in-process manager miss wrapped by AppError::Pty", () => {
    expect(
      isMissingPtyError(
        new Error(
          "pty error: pty error: no pty for session cc3fe5a0-bc1c-4172-ad7a-11f8a0e5cdce",
        ),
      ),
    ).toBe(true);
  });

  it("matches a daemon registry miss", () => {
    expect(
      isMissingPtyError(
        new Error("pty error: no pty for 01a03753-00fb-70e3-8309-478ee878d227"),
      ),
    ).toBe(true);
  });

  it("rejects other PTY failures so they stay visible to the caller", () => {
    expect(isMissingPtyError(new Error("PTY access denied"))).toBe(false);
    expect(isMissingPtyError(new Error("pty error: write failed"))).toBe(false);
    expect(isMissingPtyError("clipboard permission denied")).toBe(false);
  });
});
