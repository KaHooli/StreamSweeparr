import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Nav } from "@/components/Nav";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { configuredPublicUrl } from "@/lib/request";

const description =
  "Unmonitor & delete Sonarr/Radarr media available on your streaming services, re-monitor what leaves streaming, then search.";

/**
 * What the relative `openGraph`/`twitter` image paths below are resolved
 * against. Those tags have to carry absolute URLs, so Next needs a base — and
 * without one it logs
 *
 *   ⚠ metadataBase property in metadata export is not set for resolving social
 *     open graph or twitter images, using "http://localhost:3000".
 *
 * on every render, which is pure noise in the container log for a self-hosted
 * app nobody is posting links to.
 *
 * PUBLIC_URL is the only source available here: `metadata` is a static export
 * evaluated when the module loads, with no request to read a Host header from
 * (that is what `publicOrigin` is for). Deriving it per request would mean
 * turning this into an async `generateMetadata` that awaits `headers()`, which
 * opts *every* page out of static rendering — a real cost, paid across the
 * whole app, to perfect a preview image on a login-gated instance. Not worth it.
 *
 * So the fallback is the same localhost guess Next was already making: an
 * install that has not set PUBLIC_URL is no worse off than before, it just
 * stops being told about it once a minute. Setting PUBLIC_URL — which the
 * README already asks for behind a reverse proxy — makes these correct.
 *
 * One wrinkle worth knowing: the env read stays a runtime read in the server
 * bundle, so the dynamically rendered pages pick up whatever PUBLIC_URL the
 * container starts with. The handful of prerendered ones (/login, /runs,
 * /settings, /change-password) bake theirs at `next build`, which for the
 * published image means the fallback regardless. That is only ever an image URL
 * in a link preview, so it is not worth forcing those pages dynamic over.
 */
const metadataBase = configuredPublicUrl() ?? new URL("http://localhost:3000");

export const metadata: Metadata = {
  metadataBase,
  title: { default: "StreamSweeparr", template: "%s · StreamSweeparr" },
  description,
  applicationName: "StreamSweeparr",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/pwa-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/pwa-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180x180.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon.ico"],
  },
  appleWebApp: {
    capable: true,
    title: "StreamSweeparr",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    siteName: "StreamSweeparr",
    title: "StreamSweeparr",
    description,
    images: [{ url: "/icons/pwa-512x512.png", width: 512, height: 512, alt: "StreamSweeparr" }],
  },
  twitter: {
    card: "summary",
    title: "StreamSweeparr",
    description,
    images: ["/icons/pwa-512x512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the Dracula palette in globals.css for the browser/PWA chrome.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5fb" },
    { media: "(prefers-color-scheme: dark)", color: "#282a36" },
  ],
};

// Set the theme attribute before paint to avoid a flash of the wrong theme.
const noFlashScript = `
(function(){try{var t=localStorage.getItem('ss-theme')||'system';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','system');}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <ThemeProvider>
          <ServiceWorkerRegistrar />
          <div className="app">
            <Nav />
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
