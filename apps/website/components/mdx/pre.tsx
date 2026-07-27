"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Code-block wrapper with a copy button. rehype-pretty-code renders the inner
 * `<code>` (already highlighted); we add the chrome + clipboard action, reading
 * the rendered text off the DOM so we never re-serialize the tokens.
 */
export function Pre({ className, children, ...props }: React.ComponentProps<"pre">) {
  const ref = React.useRef<HTMLPreElement>(null);
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    const text = ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <div className="group relative my-4">
      <button
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2.5 top-2.5 z-10 inline-flex size-7 items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
      <pre
        ref={ref}
        className={cn(
          "max-h-[36rem] overflow-x-auto rounded-lg border border-border/60 bg-muted/40 py-4 text-[13px] leading-relaxed [&>code]:grid [&>code]:min-w-full",
          className,
        )}
        {...props}
      >
        {children}
      </pre>
    </div>
  );
}
