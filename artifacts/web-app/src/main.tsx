import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("MediFlow root element was not found");
}

createRoot(rootElement).render(<App />);

// A successful React mount proves the app booted, so allow one automatic
// stale-asset recovery again if a later deploy invalidates a lazy-loaded chunk.
queueMicrotask(() => {
  try {
    sessionStorage.removeItem("mediflow:staleAssetReload");
  } catch {
    // sessionStorage can be unavailable in restricted browser contexts.
  }
});
