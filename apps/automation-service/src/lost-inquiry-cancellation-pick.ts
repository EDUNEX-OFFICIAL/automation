import type { LostInquiryCancellationPick } from "@gdms/shared";

/** Skip Ollama when remark rules are this confident (0–100). */
export const CANCELLATION_RULE_CONFIDENCE_THRESHOLD = 65;

export type CancellationRulePick = {
  reasonFailure: string;
  lostDueTo: string;
  lostDueToSub: string;
  confidence: number;
  category: RemarkCategory;
  reasonScore: number;
  parentScore: number;
  subScore: number;
};

type RemarkCategory =
  | "plan_cancel"
  | "plan_postpone"
  | "human_error"
  | "competitor"
  | "budget_price"
  | "credit_finance"
  | "not_interested"
  | "dealer_stock"
  | "generic";

type CategoryHints = {
  reason: RegExp[];
  parent: RegExp[];
  sub: RegExp[];
  antiSub: RegExp[];
  antiParent: RegExp[];
};

const CATEGORY_HINTS: Record<RemarkCategory, CategoryHints> = {
  plan_cancel: {
    reason: [/customer mind change/i, /customer/i],
    parent: [/plan drop/i],
    sub: [/plan cancel/i, /cancelled plan/i, /plan cancelled/i, /^cancel$/i, /cancel plan/i],
    antiSub: [/credit/i, /shortage/i, /manufacturer/i, /competitor/i, /convenience/i, /stock/i, /dealer/i],
    antiParent: [/competitor/i, /credit/i, /budget/i],
  },
  plan_postpone: {
    reason: [/customer mind change/i, /customer/i],
    parent: [/plan drop/i, /postpone/i],
    sub: [/plan postpone/i, /postpone/i, /delay/i, /defer/i],
    antiSub: [/credit/i, /shortage/i, /manufacturer/i, /competitor/i, /typing/i],
    antiParent: [/competitor/i, /credit/i],
  },
  human_error: {
    reason: [/human error/i, /human/i],
    parent: [/human/i, /error/i, /mistake/i],
    sub: [/typing mistake/i, /system closed/i, /mistake/i, /error/i],
    antiSub: [/credit/i, /competitor/i, /plan cancel/i, /manufacturer/i],
    antiParent: [/plan drop/i, /competitor/i, /budget/i],
  },
  competitor: {
    reason: [/customer mind change/i, /competitor/i, /customer/i],
    parent: [/competitor/i, /other manufacturer/i, /manufacturer/i],
    sub: [/competitor/i, /other manufacturer/i, /manufacturer/i, /brand/i],
    antiSub: [/plan cancel/i, /typing/i, /credit shortage/i],
    antiParent: [/plan drop/i, /human/i],
  },
  budget_price: {
    reason: [/customer mind change/i, /budget/i, /customer/i],
    parent: [/budget/i, /price/i, /cost/i, /customer/i],
    sub: [/budget/i, /price/i, /cost/i, /afford/i, /expensive/i],
    antiSub: [/typing/i, /plan cancel/i, /competitor/i],
    antiParent: [/human/i, /competitor/i],
  },
  credit_finance: {
    reason: [/customer mind change/i, /credit/i, /customer/i],
    parent: [/credit/i, /finance/i, /budget/i],
    sub: [/credit shortage/i, /credit/i, /finance/i, /loan/i, /emi/i],
    antiSub: [/plan cancel/i, /typing/i, /competitor/i],
    antiParent: [/human/i, /plan drop/i],
  },
  not_interested: {
    reason: [/customer mind change/i, /customer/i],
    parent: [/customer/i, /not interest/i, /mind change/i],
    sub: [/not interest/i, /lost interest/i, /no interest/i, /mind change/i],
    antiSub: [/credit shortage/i, /typing/i],
    antiParent: [/human/i],
  },
  dealer_stock: {
    reason: [/dealer/i, /stock/i, /customer mind change/i],
    parent: [/dealer/i, /stock/i, /delivery/i],
    sub: [/stock/i, /dealer/i, /delivery/i, /availability/i],
    antiSub: [/typing/i, /plan cancel/i],
    antiParent: [/human/i],
  },
  generic: {
    reason: [/customer mind change/i, /customer/i, /human error/i],
    parent: [/plan drop/i, /customer/i, /budget/i],
    sub: [/plan cancel/i, /postpone/i, /mistake/i],
    antiSub: [],
    antiParent: [],
  },
};

function normalizeRemark(remark: string): string {
  return remark
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyLostRemark(remark: string): RemarkCategory {
  const r = normalizeRemark(remark);
  if (/plan\s*cancel|cancel\s*ho|cancelled|cancel\s*kar|plan\s*band|plan\s*drop|drop\s*plan|plan\s*nahi/i.test(r)) {
    return "plan_cancel";
  }
  if (/postpone|post\s*pon|baad\s*me|bad\s*me|delay|defer|hold\s*plan/i.test(r)) return "plan_postpone";
  if (
    /mistake|typing|galat|galti|wrong|nhi\s*kiye|nahin\s*kiye|nahi\s*kiye|error|by\s*mistake|galti\s*se|inquiry\s*nahi/i.test(
      r,
    )
  ) {
    return "human_error";
  }
  if (/competitor|hyundai\s*nahi|other\s*brand|other\s*manufacturer|maruti|tata|mahindra|\bkia\b|toyota|honda/i.test(r)) {
    return "competitor";
  }
  if (/budget|costly|expensive|price\s*high|paise|mahanga|afford|cost\s*high/i.test(r)) return "budget_price";
  if (/credit|finance|loan|emi|funding|financ/i.test(r)) return "credit_finance";
  if (/not\s*interest|uninterested|nahi\s*lena|nahi\s*chahiye|interest\s*nahi/i.test(r)) return "not_interested";
  if (/stock|dealer\s*issue|delivery\s*delay|availability/i.test(r)) return "dealer_stock";
  return "generic";
}

function scoreOptionForRemark(
  option: string,
  remark: string,
  preferred: RegExp[],
  anti: RegExp[] = [],
): number {
  const opt = option.toLowerCase();
  const rem = normalizeRemark(remark);
  let score = 0;
  for (const re of preferred) {
    if (re.test(option)) score += 35;
  }
  for (const re of anti) {
    if (re.test(option)) score -= 45;
  }
  for (const word of rem.split(/\s+/)) {
    if (word.length < 3) continue;
    if (opt.includes(word)) score += 3;
  }
  if (/cancel/i.test(rem) && /cancel/i.test(opt)) score += 8;
  if (/postpone|delay/i.test(rem) && /postpone|delay/i.test(opt)) score += 8;
  if (/mistake|typing|galat|galti/i.test(rem) && /mistake|typing|error/i.test(opt)) score += 10;
  return score;
}

function pickBestOption(
  options: string[],
  remark: string,
  preferred: RegExp[],
  anti: RegExp[] = [],
  fallbackPreferred?: RegExp[],
): { value: string; score: number } {
  if (options.length === 0) return { value: "", score: -999 };
  let best = { value: options[0]!, score: -Infinity };
  for (const o of options) {
    const score = scoreOptionForRemark(o, remark, preferred, anti);
    if (score > best.score) best = { value: o, score };
  }
  if (best.score < 5 && fallbackPreferred?.length) {
    for (const o of options) {
      const score = scoreOptionForRemark(o, remark, fallbackPreferred, anti);
      if (score > best.score) best = { value: o, score };
    }
  }
  return best;
}

function computeConfidence(category: RemarkCategory, reasonScore: number, parentScore: number, subScore: number): number {
  let confidence = category === "generic" ? 25 : 55;
  if (reasonScore >= 20) confidence += 12;
  else if (reasonScore >= 5) confidence += 5;
  if (parentScore >= 20) confidence += 12;
  else if (parentScore >= 5) confidence += 5;
  if (subScore >= 15) confidence += 15;
  else if (subScore >= 5) confidence += 6;
  if (category !== "generic" && reasonScore >= 15 && parentScore >= 15 && subScore >= 10) confidence = Math.max(confidence, 82);
  return Math.min(100, confidence);
}

/** Remark-first Cancelation dropdown resolution (Reason Failure + Lost due to parent/sub). */
export function resolveCancellationFromRemark(
  remark: string,
  reasonFailureOptions: string[],
  lostDueToOptions: string[],
  lostDueToSubOptions: string[],
): CancellationRulePick {
  const category = classifyLostRemark(remark);
  const hints = CATEGORY_HINTS[category];

  const reasonPick = pickBestOption(reasonFailureOptions, remark, hints.reason, [], [
    /customer mind change/i,
    /human error/i,
    /customer/i,
  ]);
  const parentPick = pickBestOption(lostDueToOptions, remark, hints.parent, hints.antiParent);
  const subPick = pickBestOption(lostDueToSubOptions, remark, hints.sub, hints.antiSub);

  const confidence = computeConfidence(category, reasonPick.score, parentPick.score, subPick.score);

  return {
    reasonFailure: reasonPick.value || reasonFailureOptions[0] || "",
    lostDueTo: parentPick.value || lostDueToOptions[0] || "",
    lostDueToSub: subPick.value || lostDueToSubOptions[0] || parentPick.value || "",
    confidence,
    category,
    reasonScore: reasonPick.score,
    parentScore: parentPick.score,
    subScore: subPick.score,
  };
}

export function mergeCancellationPicks(
  rule: CancellationRulePick,
  ai: LostInquiryCancellationPick | null,
  reasonOptions: string[],
  parentOptions: string[],
  subOptions: string[],
): LostInquiryCancellationPick {
  const inList = (value: string | undefined, list: string[]) =>
    !!value?.trim() && list.some((o) => o.toLowerCase() === value.toLowerCase());

  const reasonFailure =
    rule.reasonScore >= 10 && inList(rule.reasonFailure, reasonOptions)
      ? rule.reasonFailure
      : inList(ai?.reasonFailure, reasonOptions)
        ? ai!.reasonFailure
        : rule.reasonFailure;

  const lostDueTo =
    rule.parentScore >= 10 && inList(rule.lostDueTo, parentOptions)
      ? rule.lostDueTo
      : inList(ai?.lostDueTo, parentOptions)
        ? ai!.lostDueTo
        : rule.lostDueTo;

  let lostDueToSub = "";
  if (subOptions.length > 0) {
    lostDueToSub =
      rule.subScore >= 8 && inList(rule.lostDueToSub, subOptions)
        ? rule.lostDueToSub
        : inList(ai?.lostDueToSub, subOptions)
          ? ai!.lostDueToSub
          : rule.lostDueToSub;
    if (!inList(lostDueToSub, subOptions)) {
      lostDueToSub = subOptions[0] ?? lostDueTo;
    }
  } else {
    lostDueToSub = lostDueTo;
  }

  return { reasonFailure, lostDueTo, lostDueToSub };
}

export function lostDueParentHints(remark: string): RegExp[] {
  return CATEGORY_HINTS[classifyLostRemark(remark)].parent;
}

export function lostDueSubHints(remark: string): RegExp[] {
  return CATEGORY_HINTS[classifyLostRemark(remark)].sub;
}

export function scoreSubOptionForRemark(option: string, remark: string, parentSelected: string): number {
  const category = classifyLostRemark(remark);
  const hints = CATEGORY_HINTS[category];
  let score = scoreOptionForRemark(option, remark, hints.sub, hints.antiSub);
  if (category === "plan_cancel" && /plan drop/i.test(parentSelected)) {
    if (/plan cancel|plan cancelled|cancelled plan/i.test(option)) score += 25;
    else if (/cancel/i.test(option)) score += 10;
    else if (/drop/i.test(option)) score += 4;
    if (/credit|shortage|manufacturer|competitor|convenience|stock|dealer/i.test(option)) score -= 15;
  }
  if (category === "human_error" && /human|error|mistake/i.test(parentSelected)) {
    if (/typing mistake|system closed/i.test(option)) score += 20;
  }
  return score;
}

export function buildOptionCandidates(options: string[], preferred: string | undefined, remarkHints: RegExp[]): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    const v = value?.trim();
    if (!v) return;
    if (options.some((o) => o.toLowerCase() === v.toLowerCase()) && !out.some((x) => x.toLowerCase() === v.toLowerCase())) {
      out.push(options.find((o) => o.toLowerCase() === v.toLowerCase())!);
    }
  };
  add(preferred);
  for (const re of remarkHints) {
    for (const o of options) {
      if (re.test(o) && !out.some((x) => x.toLowerCase() === o.toLowerCase())) out.push(o);
    }
  }
  for (const o of options) {
    if (!out.some((x) => x.toLowerCase() === o.toLowerCase())) out.push(o);
  }
  return out.slice(0, 12);
}

export function buildSubOptionCandidates(
  options: string[],
  preferred: string | undefined,
  remark: string,
  parentSelected: string,
): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    const v = value?.trim();
    if (!v) return;
    if (options.some((o) => o.toLowerCase() === v.toLowerCase()) && !out.some((x) => x.toLowerCase() === v.toLowerCase())) {
      out.push(options.find((o) => o.toLowerCase() === v.toLowerCase())!);
    }
  };

  const skipIrrelevant = (option: string) => {
    if (classifyLostRemark(remark) === "plan_cancel" && /plan drop/i.test(parentSelected)) {
      return scoreSubOptionForRemark(option, remark, parentSelected) < 0;
    }
    return false;
  };

  const ranked = [...options]
    .filter((o) => !skipIrrelevant(o))
    .sort((a, b) => scoreSubOptionForRemark(b, remark, parentSelected) - scoreSubOptionForRemark(a, remark, parentSelected));
  for (const o of ranked) add(o);

  if (/plan drop/i.test(parentSelected) && /plan cancel|cancel ho/i.test(remark)) {
    add(options.find((o) => /plan cancel|cancelled/i.test(o)));
  }

  for (const re of lostDueSubHints(remark)) {
    for (const o of options) {
      if (re.test(o) && !skipIrrelevant(o)) add(o);
    }
  }

  if (preferred && !skipIrrelevant(preferred)) add(preferred);

  for (const o of options) {
    if (skipIrrelevant(o)) continue;
    add(o);
  }
  return out.slice(0, 12);
}
