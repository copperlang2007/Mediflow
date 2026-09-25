import { createRoot } from "react-dom/client";
import App from "./App";
import { installViewAsFetch } from "./lib/installViewAsFetch";
import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("agencyBRIDGE root element was not found");
}

installViewAsFetch();
createRoot(rootElement).render(<App />);

