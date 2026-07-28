"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no-op */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex items-center gap-3 rounded-lg border border-border/70 bg-muted/40 px-4 py-2.5 font-mono text-sm transition-colors hover:border-primary/50"
    >
      <span className="select-none text-primary">$</span>
      <span>{command}</span>
      <span className="text-muted-foreground transition-colors group-hover:text-foreground">
        {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      </span>
    </button>
  );
}
