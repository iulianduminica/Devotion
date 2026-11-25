import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/core/style.css";
import "@blocknote/mantine/style.css";
import "./styles.css";
import "katex/dist/katex.min.css";
import { App } from "./App.tsx";
import { bootstrap } from "./api.ts";

/**
 * Resolve the theme before first paint: the alternative is a visible flash of
 * dark canvas for users on the light theme.
 */
function applyStoredTheme(): void {
  const stored = localStorage.getItem("strata-theme") ?? "dark";
  const resolved =
    stored === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : stored;
  document.documentElement.setAttribute("data-theme", resolved);
}

applyStoredTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

// The API token comes from the server; render only once it is in hand.
bootstrap()
  .then(() => {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((err) => {
    root.innerHTML =
      `<div style="padding:40px;font:14px ui-sans-serif;color:#aaa">` +
      `Cannot reach the Devotion API.<br><br>` +
      `<code style="color:#f44747">${String((err as Error).message)}</code></div>`;
  });
