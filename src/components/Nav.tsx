"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { ThemeToggle } from "./ThemeProvider";
import { fetcher, postJson } from "@/lib/fetcher";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/runs", label: "Runs" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const { data } = useSWR<{ user: { username: string; method: string } | null }>(
    "/api/auth/session",
    fetcher
  );

  // The login and forced password-change pages render standalone (no chrome).
  if (pathname === "/login" || pathname === "/change-password") return null;

  const logout = async () => {
    try {
      await postJson("/api/auth/logout");
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  return (
    <header className="topbar">
      <Link href="/" className="brand" aria-label="StreamSweeparr home">
        <span className="mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/favicon-48x48.png" alt="" width={30} height={30} />
        </span>
        <span className="full">
          <span className="sweep">Stream</span>
          <span className="arr">Sweeparr</span>
        </span>
      </Link>
      <nav className="nav">
        {links.map((l) => {
          const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <Link key={l.href} href={l.href} className={active ? "active" : ""}>
              {l.label}
            </Link>
          );
        })}
      </nav>
      <span className="spacer" />
      <ThemeToggle />
      {data?.user && (
        <div className="user-menu">
          <span className="user-name" title={`Signed in via ${data.user.method}`}>
            {data.user.username}
          </span>
          <button className="btn sm ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
