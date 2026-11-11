/** Registers the app-shell worker in production builds only (dev would cache stale modules). */
export function registerServiceWorker(env: { prod: boolean } = { prod: import.meta.env.PROD }): void {
  if (!env.prod || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline shell is an enhancement; the app works without it.
    });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
