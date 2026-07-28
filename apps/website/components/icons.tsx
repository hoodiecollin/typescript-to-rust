import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * typescript-to-rust logomark — two interlocking combs: a cyan TypeScript side
 * (two teeth) meshing tooth-for-tooth with a rust Rust side (one tooth in the
 * gap). Official brand geometry (see `/brand`); colors are fixed brand values
 * (not `currentColor`) so the mark reads on any surface.
 *   TS cyan   #14b8c6
 *   Rust      #d2542a
 */
export function TtrMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 120 120" fill="none" aria-hidden="true" {...props}>
      {/* TypeScript side — cyan comb (stem + two teeth) */}
      <rect x="20" y="26" width="13" height="68" rx="6.5" fill="#14b8c6" />
      <rect x="20" y="33" width="40" height="13" rx="6.5" fill="#14b8c6" />
      <rect x="20" y="74" width="40" height="13" rx="6.5" fill="#14b8c6" />
      {/* Rust side — rust comb (stem + one tooth in the gap) */}
      <rect x="87" y="26" width="13" height="68" rx="6.5" fill="#d2542a" />
      <rect x="60" y="53.5" width="40" height="13" rx="6.5" fill="#d2542a" />
    </svg>
  );
}

/**
 * typescript-to-rust wordmark — the full name with the target language ("rust")
 * carried in the house accent, set in the brand display face (via `--font-sans`).
 */
export function TtrWordmark({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("font-semibold tracking-tight", className)} {...props}>
      typescript-to-<span className="text-primary">rust</span>
    </span>
  );
}

export function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
  );
}
