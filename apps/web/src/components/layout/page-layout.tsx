import { cn } from "@/lib/utils";

type PageLayoutProps = {
  children: React.ReactNode;
  className?: string;
  /** Narrower max width for forms (profile, login flows). */
  narrow?: boolean;
};

export function PageLayout({ children, className, narrow }: PageLayoutProps) {
  return (
    <div
      className={cn(
        "page-stack animate-fade-in",
        narrow ? "mx-auto max-w-3xl" : "w-full",
        className,
      )}
    >
      {children}
    </div>
  );
}
