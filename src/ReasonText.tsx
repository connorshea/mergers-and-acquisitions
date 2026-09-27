// Renders one reason line, decorating any Wikidata property id (Pxxx) with its
// human label. The scorer builds reasons without property labels, so they embed
// raw pids (e.g. "shares external identifier: P12813, P5794"); the API responses
// carry the labels, so we resolve them here. By default the pid stays visible
// and the label is the tooltip (the detail page); `inline` swaps them, showing
// the label with the pid as the tooltip (the compact list). Pids without a
// known label render as-is.
export default function ReasonText({
  text,
  propertyLabels,
  inline = false,
}: {
  text: string;
  propertyLabels?: Record<string, string>;
  inline?: boolean;
}) {
  // Split on pid tokens, keeping them (capturing group) so we can decorate each.
  const parts = text.split(/(\bP\d+\b)/g);
  return (
    <>
      {parts.map((part, i) => {
        const label = /^P\d+$/.test(part) ? propertyLabels?.[part] : undefined;
        if (!label) return <span key={i}>{part}</span>;
        return (
          <abbr key={i} className="reason-prop" title={inline ? part : label}>
            {inline ? label : part}
          </abbr>
        );
      })}
    </>
  );
}
