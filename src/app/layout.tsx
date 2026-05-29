import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ArbitrAI | Institutional BTC Arbitrage Intelligence",
  description: "Institutional-grade BTC arbitrage intelligence, accessible to any developer."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
