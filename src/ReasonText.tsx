import { capIdReason } from "./lib/reasons.ts";

// Renders one reason line, decorating any Wikidata property id (Pxxx) with its
// human label. The scorer builds reasons without property labels, so they embed
// raw pids (e.g. "shares external identifier: P12813, P5794"); the API responses
// carry the labels, so we resolve them here. By default the pid stays visible
// and the label is the tooltip (the detail page); `inline` swaps them, showing
// the label with the pid as the tooltip (the compact list). Pids without a
// known label render as-is. `maxIds` caps a shared-identifier list at that many
// ids, ending it "and N others" with the rest in a tooltip.
export default function ReasonText({
  text,
  propertyLabels,
  inline = false,
  maxIds,
}: {
  text: string;
  propertyLabels?: Record<string, string>;
  inline?: boolean;
  maxIds?: number;
}) {
  const capped = maxIds === undefined ? null : capIdReason(text, maxIds);
  if (capped) {
    const { prefix, shown, hidden } = capped;
    const hiddenNames = hidden.map((id) => {
      const label = propertyLabels?.[id];
      return label ? `${label} (${id})` : id;
    });
    return (
      <>
        {prefix}:{" "}
        <DecoratedPids text={shown.join(", ")} propertyLabels={propertyLabels} inline={inline} />,
        and{" "}
        <abbr className="reason-prop" title={hiddenNames.join("\n")}>
          {hidden.length} {hidden.length === 1 ? "other" : "others"}
        </abbr>
      </>
    );
  }
  return <DecoratedPids text={text} propertyLabels={propertyLabels} inline={inline} />;
}

function DecoratedPids({
  text,
  propertyLabels,
  inline,
}: {
  text: string;
  propertyLabels?: Record<string, string>;
  inline: boolean;
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
