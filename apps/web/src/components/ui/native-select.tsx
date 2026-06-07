import * as React from "react";
import { selectClass } from "@/lib/form-styles";
import { cn } from "@/lib/utils";

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** Styled native `<select>` with a single CSS chevron (no duplicate icons). */
export function NativeSelect({ className, ...props }: NativeSelectProps) {
  return <select className={cn(selectClass, className)} {...props} />;
}
