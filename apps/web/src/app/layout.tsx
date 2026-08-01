import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Locum Planner",
  description: "Relief pharmacist cover for South African pharmacies.",
};

/*
 * Nothing is cached. Every page in this app is either a signed-in view of
 * someone's own data or a login form, and a shift board served from a shared
 * cache would show one pharmacy's applicants to another.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-ZA">
      <body>{children}</body>
    </html>
  );
}
