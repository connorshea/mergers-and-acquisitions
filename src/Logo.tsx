import markOnLight from "./assets/logo/ma-logo-on-light.svg";
import markOnDark from "./assets/logo/ma-logo-on-dark.svg";

// The logo ships as separate light/dark SVGs (only the ink color differs).
// Render both and let CSS show the one matching the active theme, so the swap
// follows the same prefers-color-scheme / data-theme rules as the color tokens.
// Both carry the alt text: the hidden one is display:none, which drops it from
// the accessibility tree, so it is never announced twice.
function Themed({
  light,
  dark,
  alt,
  className,
}: {
  light: string;
  dark: string;
  alt: string;
  className: string;
}) {
  return (
    <>
      <img className={`${className} on-light`} src={light} alt={alt} />
      <img className={`${className} on-dark`} src={dark} alt={alt} />
    </>
  );
}

/** The mark alone; decorative by default since it sits beside a text label. */
export function LogoMark({ alt = "" }: { alt?: string }) {
  return <Themed light={markOnLight} dark={markOnDark} alt={alt} className="logo-mark" />;
}
