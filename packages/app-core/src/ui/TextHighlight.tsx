/**
 * Text with character ranges emphasised (search snippets): `<TextHighlight text ranges={[[0, 4]]} />`.
 * Ranges are `[start, end)`, may be unsorted; overlapping ranges merge.
 */
export function TextHighlight({ text, ranges }: { text: string; ranges: ReadonlyArray<readonly [number, number]> }) {
  if (!ranges.length) return <>{text}</>;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const parts: preact.JSX.Element[] = [];
  let at = 0;
  for (const [start, end] of sorted) {
    const s = Math.max(start, at);
    if (end <= s) continue;
    if (s > at) parts.push(<span key={`t${at}`}>{text.slice(at, s)}</span>);
    parts.push(
      <b key={`h${s}`} class="font-semibold">
        {text.slice(s, end)}
      </b>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}
