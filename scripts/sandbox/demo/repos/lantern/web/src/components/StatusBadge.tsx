export function StatusBadge({ ok }: { ok: boolean | null }) {
  const label = ok === null ? "No data" : ok ? "Operational" : "Down";
  return <span class={`badge badge-${ok === null ? "unknown" : ok ? "up" : "down"}`}>{label}</span>;
}
