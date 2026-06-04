"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AUTOMATION_SOURCES,
  AUTOMATION_REMARK_SUFFIX,
  formatAutomationRemark,
  SUB_SOURCES_BY_PARENT,
  type AutomationSource,
  type EnquiryRemarkRule,
  type SubSourceParent,
} from "@gdms/shared";
import { cn } from "@/lib/utils";
import { NativeSelect } from "@/components/ui/native-select";

function RemarkSuffixPreview({ base }: { base: string }) {
  const preview = base.trim() ? formatAutomationRemark(base) : AUTOMATION_REMARK_SUFFIX;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
      <span className="font-mono text-foreground">{preview.replace(AUTOMATION_REMARK_SUFFIX, "")}</span>
      <span className="select-none font-mono text-muted-foreground" aria-hidden>
        {AUTOMATION_REMARK_SUFFIX}
      </span>
      <span className="sr-only"> (automation suffix, not editable)</span>
    </span>
  );
}

function sourceNeedsSub(source: AutomationSource): source is SubSourceParent {
  return source === "Digital" || source === "CRM";
}

export type RemarkSettingsFormState = {
  defaultEnquiryRemarkBase: string;
  enquiryRemarkRules: EnquiryRemarkRule[];
  followUpSkipRemarkBases: string[];
};

type RemarkSettingsCardsProps = {
  value: RemarkSettingsFormState;
  onChange: (next: RemarkSettingsFormState) => void;
  disabled?: boolean;
};

export function RemarkSettingsCards({ value, onChange, disabled }: RemarkSettingsCardsProps) {
  function updateRule(index: number, patch: Partial<EnquiryRemarkRule>): void {
    const rules = [...value.enquiryRemarkRules];
    const cur = rules[index];
    if (!cur) return;
    rules[index] = { ...cur, ...patch };
    onChange({ ...value, enquiryRemarkRules: rules });
  }

  function addRule(): void {
    onChange({
      ...value,
      enquiryRemarkRules: [
        ...value.enquiryRemarkRules,
        { source: "Digital", subSource: "Website", remarkBase: "" },
      ],
    });
  }

  function removeRule(index: number): void {
    onChange({
      ...value,
      enquiryRemarkRules: value.enquiryRemarkRules.filter((_, i) => i !== index),
    });
  }

  function updateSkipRemark(index: number, text: string): void {
    const bases = [...value.followUpSkipRemarkBases];
    bases[index] = text;
    onChange({ ...value, followUpSkipRemarkBases: bases });
  }

  function addSkipRemark(): void {
    onChange({ ...value, followUpSkipRemarkBases: [...value.followUpSkipRemarkBases, ""] });
  }

  function removeSkipRemark(index: number): void {
    onChange({
      ...value,
      followUpSkipRemarkBases: value.followUpSkipRemarkBases.filter((_, i) => i !== index),
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Enquiry transfer remarks</CardTitle>
        </CardHeader>
        <CardContent className="max-w-3xl space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="default-enquiry-remark">Default remark</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="default-enquiry-remark"
                className="max-w-xs"
                value={value.defaultEnquiryRemarkBase}
                disabled={disabled}
                placeholder="Call Back"
                onChange={(e) =>
                  onChange({ ...value, defaultEnquiryRemarkBase: e.target.value })
                }
              />
              <RemarkSuffixPreview base={value.defaultEnquiryRemarkBase || "Call Back"} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm font-medium">Source rules</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={addRule}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add rule
              </Button>
            </div>

            {value.enquiryRemarkRules.length === 0 ? null : (
              <ul className="space-y-3">
                {value.enquiryRemarkRules.map((rule, i) => (
                  <li
                    key={`${rule.source}-${rule.subSource ?? ""}-${i}`}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:flex-wrap sm:items-end"
                  >
                    <div className="min-w-[140px] flex-1 space-y-1">
                      <Label className="text-xs">Source</Label>
                      <NativeSelect
                        className={cn(disabled && "opacity-50")}
                        disabled={disabled}
                        value={rule.source}
                        onChange={(e) => {
                          const source = e.target.value as AutomationSource;
                          const patch: Partial<EnquiryRemarkRule> = { source };
                          if (!sourceNeedsSub(source)) patch.subSource = undefined;
                          else if (!rule.subSource) {
                            patch.subSource = SUB_SOURCES_BY_PARENT[source][0];
                          }
                          updateRule(i, patch);
                        }}
                      >
                        {AUTOMATION_SOURCES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="min-w-[160px] flex-1 space-y-1">
                      <Label className="text-xs">Sub-source</Label>
                      <NativeSelect
                        className={cn((!sourceNeedsSub(rule.source) || disabled) && "opacity-50")}
                        disabled={disabled || !sourceNeedsSub(rule.source)}
                        value={rule.subSource ?? ""}
                        onChange={(e) =>
                          updateRule(i, {
                            subSource: e.target.value || undefined,
                          })
                        }
                      >
                        {sourceNeedsSub(rule.source) ? (
                          SUB_SOURCES_BY_PARENT[rule.source].map((sub) => (
                            <option key={sub} value={sub}>
                              {sub}
                            </option>
                          ))
                        ) : (
                          <option value="">—</option>
                        )}
                      </NativeSelect>
                    </div>
                    <div className="min-w-[180px] flex-[2] space-y-1">
                      <Label className="text-xs">Remark</Label>
                      <Input
                        value={rule.remarkBase}
                        disabled={disabled}
                        placeholder="e.g. Busy line"
                        onChange={(e) => updateRule(i, { remarkBase: e.target.value })}
                      />
                    </div>
                    <div className="flex items-center gap-2 pb-0.5">
                      <RemarkSuffixPreview base={rule.remarkBase} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={disabled}
                        aria-label="Remove rule"
                        onClick={() => removeRule(i)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Follow Up Skip remarks</CardTitle>
        </CardHeader>
        <CardContent className="max-w-xl space-y-4">
          <ul className="space-y-2">
            {value.followUpSkipRemarkBases.map((base, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[200px] flex-1"
                  value={base}
                  disabled={disabled}
                  placeholder="e.g. not responding"
                  onChange={(e) => updateSkipRemark(i, e.target.value)}
                />
                <RemarkSuffixPreview base={base} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  disabled={disabled || value.followUpSkipRemarkBases.length <= 1}
                  aria-label="Remove remark"
                  onClick={() => removeSkipRemark(i)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>

          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addSkipRemark}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add remark
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
