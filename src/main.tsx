import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppRecoveryBoundary } from "./components/AppRecoveryBoundary";

// Block right-click context menu (Inspector access) globally.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Block common Inspector keyboard shortcuts.
window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const isWindows = /^(Win32|Win64|Windows)/u.test(navigator.platform);
  const isTerminalTarget =
    e.target instanceof Element &&
    e.target.closest(".acorn-terminal") !== null;
  // F12, Cmd/Ctrl+Shift+I, Cmd/Ctrl+Shift+J, and Cmd/Ctrl+Shift+C except
  // in a Windows terminal, where that chord copies the xterm selection.
  // Cmd/Ctrl+Alt+I belongs to Acorn's multi-input toggle.
  if (
    key === "f12" ||
    (meta &&
      e.shiftKey &&
      (key === "i" ||
        key === "j" ||
        (key === "c" && (!isWindows || !isTerminalTarget))))
  ) {
    e.preventDefault();
    e.stopPropagation();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRecoveryBoundary>
      <App />
    </AppRecoveryBoundary>
  </React.StrictMode>,
);
