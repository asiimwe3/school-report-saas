import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeryCode School Reports",
  description: "Multi-tenant school report management for Ugandan schools",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
