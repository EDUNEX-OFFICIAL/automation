import { Suspense } from "react";

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>{children}</Suspense>;
}
