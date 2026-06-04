import { cn } from "@/lib/utils";

type SectionBlockProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
};

export function SectionBlock({ title, description, children, className }: SectionBlockProps) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="space-y-1">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
        {description ? <p className="text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
