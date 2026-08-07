"use client";

import { useEffect } from "react";

/**
 * Installs (or, in development, removes) the service worker in `public/sw.js`.
 *
 * Renders nothing — it exists so the registration runs once per page load from
 * inside the React tree rather than from an inline script in the document head.
 *
 * Development deliberately unregisters instead of registering. A dev server and
 * a production build routinely share an origin (`localhost:3000`), and a
 * service worker installed by one outlives the other; the version that caches
 * hashed build assets is not something you want sitting in front of a dev
 * server that rebuilds them on every keystroke.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void unregisterAll();
      return;
    }

    // Registering during load competes with the page's own requests for
    // bandwidth, and the worker is of no use to the load that installs it.
    const register = () => void registerWorker();
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

async function registerWorker() {
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    // A worker that is already waiting (a redeploy happened while this tab was
    // open) is told to take over now. Nothing user-visible is cached, so there
    // is no stale HTML to reload for — the swap is invisible.
    if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          installing.postMessage({ type: "SKIP_WAITING" });
        }
      });
    });
  } catch {
    // An unsupported browser, a private window, or plain HTTP on a non-localhost
    // host. The app works without a service worker; it just is not installable.
  }
}

async function unregisterAll() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("streamsweeparr-")).map((n) => caches.delete(n))
      );
    }
  } catch {
    // Nothing to clean up, or the browser denied access to the caches.
  }
}
