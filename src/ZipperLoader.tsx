/**
 * A loading indicator styled after the logo: a slider runs along a zipper,
 * meshing the two rows of teeth behind it, then runs back to open them again.
 * Carries a visible label and is announced politely to screen readers.
 */
export default function ZipperLoader({ label }: { label: string }) {
  return (
    <span className="zipper-loader" role="status">
      <span className="zipper" aria-hidden="true">
        <span className="zipper-open" />
        <span className="zipper-closed" />
        <span className="zipper-pull">
          <span className="zipper-slider" />
        </span>
      </span>
      {label}
    </span>
  );
}
