// Keep the entry screen visible if the application bundle fails before React mounts.
let startupError = "The application did not start.";
window.addEventListener("error", (event) => {
  startupError = event.error?.message || event.message || `A script failed to load: ${event.target?.src || event.target?.href || "unknown resource"}`;
}, true);
window.addEventListener("unhandledrejection", (event) => {
  startupError = event.reason?.message || String(event.reason);
});
setTimeout(() => {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) return;
  const panel = document.createElement("main");
  panel.style.cssText = "min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#fff;font:16px system-ui;padding:24px;text-align:center";
  const content = document.createElement("div");
  const title = document.createElement("h1");
  title.textContent = "MediFlow could not start";
  const message = document.createElement("p");
  message.textContent = startupError;
  const retry = document.createElement("a");
  retry.href = location.href;
  retry.textContent = "Reload page";
  retry.style.color = "#93c5fd";
  content.append(title, message, retry);
  panel.append(content);
  root.append(panel);
}, 4000);
