import type { InputHTMLAttributes } from "react";

/** Props for fields that must not receive saved login credentials from the browser. */
export function suppressLoginAutofillProps(
  kind: "username" | "password",
  fieldName: string,
): InputHTMLAttributes<HTMLInputElement> {
  const common = {
    "data-lpignore": "true",
    "data-1p-ignore": "true" as const,
    "data-form-type": "other",
  };
  if (kind === "password") {
    return {
      ...common,
      name: fieldName,
      autoComplete: "new-password",
    };
  }
  return {
    ...common,
    name: fieldName,
    autoComplete: "off",
  };
}

/** Shared form control classes for consistent MNC-style UI. */
const fieldBase =
  "w-full rounded-lg border border-input bg-card px-4 text-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-card";

export const inputClass = `block h-11 min-h-11 ${fieldBase}`;

export const selectClass = `native-select-control block h-11 min-h-11 w-full appearance-none bg-none ${fieldBase} pr-11`;

export const textareaClass = `min-h-[120px] ${fieldBase} py-3 font-mono text-xs leading-relaxed`;

export const checkboxClass = "h-4 w-4 rounded border-input text-primary focus:ring-ring";
