import * as React from "react";
import { inputClass, suppressLoginAutofillProps } from "@/lib/form-styles";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /**
   * Stops Chrome/Edge from injecting saved login credentials into team/GDMS forms.
   * Uses readonly-until-focus + non-login autocomplete tokens.
   */
  suppressAutofill?: boolean;
  /** Unique field name when suppressAutofill is set (avoids matching login form). */
  autofillFieldKey?: string;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      suppressAutofill,
      autofillFieldKey = "field",
      readOnly,
      onFocus,
      autoComplete,
      name,
      ...props
    },
    ref,
  ) => {
    const [blockAutofill, setBlockAutofill] = React.useState(Boolean(suppressAutofill));
    const autofillKind = type === "password" ? "password" : "username";
    const guard = suppressAutofill
      ? suppressLoginAutofillProps(autofillKind, `gdms-${autofillFieldKey}`)
      : null;

    return (
      <input
        type={type}
        className={cn(inputClass, className)}
        ref={ref}
        readOnly={blockAutofill || readOnly}
        name={guard?.name ?? name}
        autoComplete={guard?.autoComplete ?? autoComplete}
        {...(guard
          ? {
              "data-lpignore": "true",
              "data-1p-ignore": true,
              "data-form-type": "other",
            }
          : {})}
        onFocus={(e) => {
          if (blockAutofill) setBlockAutofill(false);
          onFocus?.(e);
        }}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
