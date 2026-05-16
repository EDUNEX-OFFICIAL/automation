import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AutomationSessionHydrate } from "@/components/automation-session-hydrate";
import { ClientBootstrap } from "@/components/client-bootstrap";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "GDMS Automation",
  description: "Hyundai GDMS workflow automation MVP",
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
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        <ClientBootstrap />
        <AutomationSessionHydrate />
        {children}
      </body>
    </html>
  );
}
