import { Dashboard } from "@/components/Dashboard";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";

export default function TerminalPage() {
  return (
    <main className="grid h-screen w-full min-w-0 max-w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <PublicSiteHeader compact />
      <div className="min-h-0">
        <Dashboard />
      </div>
    </main>
  );
}
