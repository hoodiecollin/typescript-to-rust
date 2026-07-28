import { highlight } from "@/lib/shiki";
import { cn } from "@/lib/utils";

/**
 * Server component: highlights a code string at build time and renders it with
 * the site's code-block chrome. Used on the marketing landing (docs pages get
 * highlighting through the MDX pipeline instead).
 */
export async function CodeBlock({
  code,
  lang,
  filename,
  className,
}: {
  code: string;
  lang: string;
  filename?: string;
  className?: string;
}) {
  const html = await highlight(code.trim(), lang);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-muted/30",
        className,
      )}
    >
      {filename ? (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/50 px-4 py-2 font-mono text-xs text-muted-foreground">
          <span className="size-2.5 rounded-full bg-border" />
          {filename}
        </div>
      ) : null}
      <div
        className="overflow-x-auto p-4 text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:!m-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renders Shiki-highlighted HTML generated at build time from our own source — trusted
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
