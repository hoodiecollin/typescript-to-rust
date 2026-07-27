"use client";

import type { ReactNode } from "react";
import { Provider } from "jotai";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/**
 * Client providers: theme (dark by default, follows system preference) + jotai
 * store + shadcn tooltip context + toast portal.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <Provider>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster />
      </Provider>
    </ThemeProvider>
  );
}
