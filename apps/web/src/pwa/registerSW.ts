/**
 * Registers the generated service worker (build/pwa.ts: an offline page for navigations, nothing
 * else) in production builds only, so the dev server never gets a cached shell. Needs HTTPS or
 * localhost; a no-op where service workers are unsupported.
 */
export function registerServiceWorker(nav: Navigator = navigator, prod: boolean = import.meta.env.PROD): void {
  if (!prod || !('serviceWorker' in nav)) return;
  const register = () => void nav.serviceWorker.register('/sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
