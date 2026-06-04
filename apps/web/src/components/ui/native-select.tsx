import * as React from "react";
import { ChevronDown } from "lucide-react";
import { selectClass } from "@/lib/form-styles";
import { cn } from "@/lib/utils";

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** Styled native `<select>` with consistent chevron spacing. */
export function NativeSelect({ className, ...props }: NativeSelectProps) {
  return (
    <div className="relative">
      <select className={cn(selectClass, className)} {...props} />
      <ChevronDown
        className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}
