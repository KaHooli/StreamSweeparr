import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Nav } from "@/components/Nav";

const description =
  "Unmonitor & delete Sonarr/Radarr media available on your streaming services, re-monitor what leaves streaming, then search.";

export const metadata: Metadata = {
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
          <div className="app">
            <Nav />
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
