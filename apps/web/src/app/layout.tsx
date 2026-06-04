import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AutomationSessionHydrate } from "@/components/automation-session-hydrate";
import { SessionProvider } from "@/components/auth/session-provider";
import { ClientBootstrap } from "@/components/client-bootstrap";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GDMS Automation",
    template: "%s · GDMS Automation",
  },
  description: "Enterprise dealer workflow automation for Hyundai GDMS",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${fontSans.variable} font-sans antialiased`}>
        <ThemeProvider>
          <ClientBootstrap />
          <AutomationSessionHydrate />
          <SessionProvider>{children}</SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
