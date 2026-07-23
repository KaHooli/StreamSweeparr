import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "StreamSweeparr",
  description:
    "Unmonitor & delete Sonarr/Radarr media available on your streaming services, re-monitor what leaves streaming, then search.",
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
