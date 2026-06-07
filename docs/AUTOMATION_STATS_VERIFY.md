# Automation stats — verification checklist

After deploy, confirm role-based KPIs on Dashboard / Platform Analytics:

## Roles

- [ ] **Team Leader** — Dashboard shows KPIs + SC breakdown for own team only
- [ ] **Sales Consultant** — Dashboard shows only own counts
- [ ] **Dealer Admin** — `/dashboard` shows TL-wise + SC-wise (no START workspace)
- [ ] **Super Admin** — `/platform/analytics` shows dealer grid + TL/SC when dealer selected

## Operations

- [ ] Run **Enquiry transfer** → `enquiryTransfer` KPI +1; SC name in breakdown matches rotation
- [ ] Run **Follow Up Skip** → `followUpSkip` KPI +1; SC parsed from Today's Follow Up list row
- [ ] Run **Lost Inquiry** → `lostInquiry` KPI +1; SC from enquiry modal dropdown; Cancelation dropdowns via Ollama

## Lost Inquiry (manual)

1. Settings → enable Lost Inquiry + Saturday IST time + Ollama model (AI tab)
2. Dashboard → **START Lost Inquiry** (TL/SC, Digital + Field)
3. Live session workspace 2: Follow-Up Due Date TO = upcoming Sunday → Search → Lost rows processed
4. Confirm one enquiry: history remark parsed, dropdowns filled, Lost Enquiry → Confirm
5. Dashboard SC table **Lost inquiry** column increments for correct consultant
6. Saturday schedule fires once per week; Settings **Run now** works when enabled

## Date ranges (IST)

- [ ] **Today** — only events since IST midnight
- [ ] **This week** — Monday–Sunday IST
- [ ] **This month** — calendar month IST
- [ ] **Custom** — respects from/to inputs

## Historical data (optional)

```bash
DATABASE_URL=... node scripts/backfill-automation-stats.mjs
```

Creates synthetic events from old `WorkflowRun.runParams.metrics.processed` (label: `Unknown (historical)`).
