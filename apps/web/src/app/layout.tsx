import { getSession } from "@/lib/auth-session";
import type { Metadata } from "next";
import Link from "next/link";
import { logoutAction } from "./login/actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "GrowthOS",
  description: "GTM intelligence platform for B2B founders",
};

const navItems = [
  { href: "/approvals", label: "Approvals" },
  { href: "/motion", label: "Motion" },
  { href: "/signals", label: "Signals" },
  { href: "/weekly-review", label: "Weekly Review" },
  { href: "/settings", label: "Settings" },
];

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-gray-50 antialiased">
        {/* ── Top navigation ───────────────────────────────────────────── */}
        <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/60">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
            {/* Logo */}
            <Link
              href="/"
              className="flex items-center gap-2 font-semibold text-gray-900"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
                G
              </span>
              <span className="text-sm">GrowthOS</span>
            </Link>

            {/* Nav links */}
            {session && (
              <nav className="flex items-center gap-1">
                {navItems.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className="rounded-md px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
                  >
                    {label}
                  </Link>
                ))}
              </nav>
            )}

            {/* Right side: session + env badge */}
            <div className="ml-auto flex items-center gap-3">
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                Phase 1 Dev
              </span>
              {session && (
                <>
                  <span className="text-xs text-gray-500">
                    {session.userId}
                  </span>
                  <form action={logoutAction}>
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      Sign out
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
        </header>

        {/* ── Main content ─────────────────────────────────────────────── */}
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </body>
    </html>
  );
}
