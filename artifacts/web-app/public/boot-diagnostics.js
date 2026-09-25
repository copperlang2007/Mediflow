// Keep the entry screen visible if the application bundle fails before React mounts.
let startupError = "The application did not start.";

// When a deploy replaces hashed bundles, browsers holding a stale index.html
// preload assets that no longer exist. Reload once so the freshly-served
// index.html (with current hashes) is fetched. sessionStorage guards against
// reload loops if the failure is not caused by a stale cache.
const RELOAD_FLAG = "mediflow:staleAssetReload";
function reloadForStaleAssets() {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch (_e) {
    // sessionStorage unavailable (private mode, etc.) — fall through without reload.
    return false;
  }
  location.reload();
  return true;
}
function isHashedAssetUrl(url) {
  if (!url) return false;
  // Vite emits /assets/<name>-<hash>.<ext>; match the hash suffix.
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+(?:$|\?)/.test(url);
}
function isBootCriticalTarget(target) {
  if (!target || target === window) return false;
  const tag = target.tagName;
  if (tag === "SCRIPT") return true;
  if (tag === "LINK") {
    const rel = (target.rel || "").toLowerCase();
    return rel === "stylesheet" || rel === "modulepreload" || rel === "preload";
  }
  return false;
}

window.addEventListener("error", (event) => {
  const target = event.target;
  const url = target?.src || target?.href || "";
  startupError = `Error at ${target?.tagName || "window"} ${url}: ${event.error?.stack || event.message || "resource failed"}`;
  if (isBootCriticalTarget(target) && isHashedAssetUrl(url)) {
    reloadForStaleAssets();
  }
}, true);
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  startupError = reason?.message || String(reason);
  const message = typeof reason?.message === "string" ? reason.message : "";
  // Vite/browsers surface dynamic-import failures with these phrases.
  if (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    isHashedAssetUrl(message)
  ) {
    reloadForStaleAssets();
  }
});
// Vite dispatches this when a <link rel="modulepreload"> asset fails to load.
window.addEventListener("vite:preloadError", (event) => {
  const payload = event?.payload;
  const url = payload?.href || payload?.url || "";
  if (isHashedAssetUrl(url) || url === "") {
    reloadForStaleAssets();
  }
});
// The React entrypoint clears RELOAD_FLAG only after React commits. Do not infer
// success from #root children here: the diagnostic failure panel also adds one.

setTimeout(() => {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) return;
  const panel = document.createElement("main");
  panel.style.cssText = "min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#fff;font:16px system-ui;padding:24px;text-align:center";
  const content = document.createElement("div");
  const title = document.createElement("h1");
  title.textContent = "agencyBRIDGE could not start";
  const message = document.createElement("p");
  message.textContent = startupError;
  const retry = document.createElement("a");
  retry.href = location.href;
  retry.textContent = "Reload page";
  retry.style.color = "#93c5fd";
  retry.addEventListener("click", () => {
    try { sessionStorage.removeItem(RELOAD_FLAG); } catch (_e) {}
  });
  content.append(title, message, retry);
  panel.append(content);
  root.append(panel);
}, 4000);
