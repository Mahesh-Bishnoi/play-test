import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
import { getInitialTheme } from "./theme.js";
import "./styles.css";

// Set the persisted theme before first paint so a light-theme user never
// flashes through dark on reload.
document.documentElement.dataset.theme = getInitialTheme();

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("missing #root element");
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
