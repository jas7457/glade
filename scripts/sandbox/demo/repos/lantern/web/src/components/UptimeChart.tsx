import { useEffect, useState } from "preact/hooks";

interface Point {
  ok: boolean;
  latencyMs: number;
  at: number;
}

const BAR_WIDTH = 4;
const HEIGHT = 48;

export function UptimeChart({ checkId }: { checkId: string }) {
  const [points, setPoints] = useState<Point[]>([]);

  useEffect(() => {
    const source = new EventSource(`/api/checks/${checkId}/stream`);
    source.onmessage = (e) => setPoints((prev) => [...prev, JSON.parse(e.data)].slice(-90));
    return () => source.close();
  }, [checkId]);

  const max = Math.max(...points.map((p) => p.latencyMs), 1);
  return (
    <svg class="uptime-chart" width={points.length * (BAR_WIDTH + 1)} height={HEIGHT}>
      {points.map((p, i) => (
        <rect
          key={i}
          x={i * (BAR_WIDTH + 1)}
          y={HEIGHT - (p.latencyMs / max) * HEIGHT}
          width={BAR_WIDTH}
          height={(p.latencyMs / max) * HEIGHT}
          class={p.ok ? "bar-up" : "bar-down"}
        />
      ))}
    </svg>
  );
}
