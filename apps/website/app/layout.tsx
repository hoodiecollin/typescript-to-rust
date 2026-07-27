import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { site } from "@/lib/site";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { CommandMenu } from "@/components/docs/search";

// Space Grotesk for display/wordmark/body, JetBrains Mono for code and labels.
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: "typescript-to-rust — idiomatic Rust from a strict TypeScript subset",
    template: "%s — typescript-to-rust",
  },
  description: site.description,
  keywords: [
    "typescript-to-rust",
    "ttr",
    "TypeScript to Rust",
    "transpiler",
    "Rust code generation",
    "ownership inference",
    "idiomatic Rust",
  ],
  openGraph: {
    title: "typescript-to-rust — idiomatic Rust from a strict TypeScript subset",
    description:
      "Translate a strict, explicitly-enforced subset of TypeScript into idiomatic Rust with real ownership and borrows.",
    url: site.url,
    siteName: "typescript-to-rust",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("font-sans", spaceGrotesk.variable, jetbrainsMono.variable)}
    >
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>
          <div className="relative flex min-h-dvh flex-col">
            <SiteHeader />
            <div className="flex-1">{children}</div>
            <SiteFooter />
          </div>
          <CommandMenu />
        </Providers>
      </body>
    </html>
  );
}
