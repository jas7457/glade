import { useEffect, useState } from "preact/hooks";
import { StatusBadge } from "./components/StatusBadge";
import { UptimeChart } from "./components/UptimeChart";

interface CheckSummary {
  id: string;
  name: string;
  url: string;
  uptime24h: number | null;
  last: { ok: boolean; latencyMs: number; at: number } | null;
}

export function App() {
  const [checks, setChecks] = useState<CheckSummary[]>([]);

  useEffect(() => {
    const load = () => fetch("/api/checks").then((r) => r.json()).then(setChecks);
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main class="dashboard">
      <h1>Status</h1>
      {checks.map((check) => (
        <section key={check.id} class="check">
          <header>
            <StatusBadge ok={check.last?.ok ?? null} />
            <h2>{check.name}</h2>
            <span class="uptime">{check.uptime24h === null ? "—" : `${(check.uptime24h * 100).toFixed(2)}%`}</span>
          </header>
          <UptimeChart checkId={check.id} />
        </section>
      ))}
    </main>
  );
}
