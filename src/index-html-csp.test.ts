import { describe, expect, it } from "vitest";

import indexHtml from "../index.html?raw";

describe("index.html", () => {
  // Tauri appends a `nonce-` source to `style-src` when index.html carries an
  // inline <style>. A nonce source makes the browser ignore 'unsafe-inline',
  // which blocks every stylesheet injected at runtime — including the ones
  // xterm.js creates for terminal font metrics and the ANSI palette. Keep the
  // pre-hydration styles in a linked file so the configured CSP is what ships.
  it("carries no inline <style>, so Tauri leaves style-src alone", () => {
    expect(indexHtml).not.toMatch(/<style[\s>]/i);
  });

  it("links the startup fallback stylesheet instead", () => {
    expect(indexHtml).toContain('href="/startup-fallback.css"');
  });
});
