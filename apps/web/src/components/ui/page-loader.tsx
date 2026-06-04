import { cn } from "@/lib/utils";

type PageLoaderProps = {
  message?: string;
  className?: string;
};

export function PageLoader({ message = "Loading workspace…", className }: PageLoaderProps) {
  return (
    <div
      className={cn(
        "flex min-h-screen flex-col items-center justify-center gap-6 gradient-mesh px-4",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="relative h-12 w-12" aria-hidden>
          <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-primary/15 border-t-primary" />
          <div className="absolute inset-2 rounded-full bg-primary/10" />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">{message}</p>
        </div>
      </div>
    </div>
  );
}
