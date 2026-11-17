/** Reusable OpsPilot Horizon Gauge symbol using DESIGN.md CSS tokens. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="var(--color-accent, #52d9b7)"
        d="M 51 126 H 86 L 128 84 L 170 126 H 205 V 150 H 160 L 128 118 L 96 150 H 51 Z"
      />
      <path
        fill="var(--color-text, #e8edf5)"
        fillRule="evenodd"
        d="M 68 24 H 188 A 44 44 0 0 1 232 68 V 188 A 44 44 0 0 1 188 232 H 68 A 44 44 0 0 1 24 188 V 68 A 44 44 0 0 1 68 24 Z M 69.0 50 A 17.0 17.0 0 0 0 52 67.0 V 189.0 A 17.0 17.0 0 0 0 69.0 206 H 187.0 A 17.0 17.0 0 0 0 204 189.0 V 67.0 A 17.0 17.0 0 0 0 187.0 50 Z"
      />
    </svg>
  );
}
