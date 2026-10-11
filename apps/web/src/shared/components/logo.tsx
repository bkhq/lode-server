import { cn } from "@/shared/lib/utils";

interface LogoProps {
  className?: string;
}

/**
 * The brand mark: a block of rock in section, three strata displaced by a
 * fault, the middle one the lode. Flat colours, so it needs no ids and reads
 * the same in light and dark. `public/logo.svg` is the same drawing.
 */
export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-6", className)}
      aria-hidden="true"
    >
      <rect width="128" height="128" rx="28" fill="#1E2340" />
      <g strokeLinecap="round" strokeLinejoin="round">
        <path d="M26 38h30l16 16h30" stroke="#5F68B0" strokeWidth="9" />
        <path d="M26 60h30l16 16h30" stroke="#F2B441" strokeWidth="13" />
        <path d="M26 82h30l16 16h30" stroke="#5F68B0" strokeWidth="9" />
      </g>
    </svg>
  );
}
