import { describe, expect, it } from "vitest";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("Tauri core capability", () => {
  it("grants only the core commands used by the main renderer", () => {
    const corePermissions = defaultCapability.permissions
      .filter(
        (permission): permission is string =>
          typeof permission === "string" && permission.startsWith("core:"),
      )
      .sort();

    expect(corePermissions).toEqual(
      [
        "core:app:allow-version",
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:path:allow-join",
        "core:path:allow-resolve-directory",
        "core:resources:allow-close",
        "core:window:allow-destroy",
        "core:window:allow-scale-factor",
        "core:window:allow-set-focus",
        "core:window:allow-show",
        "core:window:allow-unminimize",
      ].sort(),
    );
  });

  it("does not expose renderer window enumeration, event emission, or devtools", () => {
    expect(defaultCapability.permissions).not.toContain("core:window:default");
    expect(defaultCapability.permissions).not.toContain("core:event:default");
    expect(defaultCapability.permissions).not.toContain("core:webview:default");
    expect(defaultCapability.permissions).not.toContain(
      "core:webview:allow-internal-toggle-devtools",
    );
  });

  it("grants only the plugin operations used by bounded local persistence", () => {
    expect(defaultCapability.permissions).toEqual(
      expect.arrayContaining([
        "fs:allow-fstat",
        "fs:allow-lstat",
        "fs:allow-open",
        "fs:allow-read",
        "fs:allow-write",
        "notification:allow-register-listener",
      ]),
    );
    expect(defaultCapability.permissions).not.toContain("fs:default");
    expect(defaultCapability.permissions).not.toContain("notification:default");
    expect(defaultCapability.permissions).not.toContain("opener:default");
    expect(defaultCapability.permissions).not.toContain(
      "opener:allow-open-url",
    );
    expect(defaultCapability.permissions).not.toContain(
      "opener:allow-open-path",
    );
  });
});

describe("Tauri renderer policy", () => {
  it("keeps production script execution local and blocks fallback sinks", () => {
    const csp = tauriConfig.app.security.csp;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("manifest-src 'none'");
    expect(tauriConfig.app.windows[0]?.devtools).toBe(false);
  });

  it("keeps development-only eval from weakening the other CSP sinks", () => {
    const devCsp = tauriConfig.app.security.devCsp;
    expect(devCsp).toContain("script-src 'self' 'unsafe-eval'");
    expect(devCsp).toContain("form-action 'none'");
    expect(devCsp).toContain("worker-src 'none'");
    expect(devCsp).toContain("manifest-src 'none'");
  });
});
