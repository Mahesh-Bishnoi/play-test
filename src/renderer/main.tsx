import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("missing #root element");
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
