import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Block right-click context menu (Inspector access) globally.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Block common Inspector keyboard shortcuts.
window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  // F12, Cmd/Ctrl+Shift+I, Cmd/Ctrl+Shift+J, Cmd/Ctrl+Shift+C.
  // Cmd/Ctrl+Alt+I belongs to Acorn's multi-input toggle.
  if (
    key === "f12" ||
    (meta && e.shiftKey && (key === "i" || key === "j" || key === "c"))
  ) {
    e.preventDefault();
    e.stopPropagation();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
