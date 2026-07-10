import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";
import { TerminalHero } from "@/components/TerminalHero";

export const metadata: Metadata = { title: "Terminal en vivo" };

export default function TerminalPage() {
  return (
    <main className="grid h-screen w-full min-w-0 max-w-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
      <PublicSiteHeader compact />
      <TerminalHero />
      <div className="min-h-0">
        <Dashboard />
      </div>
    </main>
  );
}
