# Follow Up Skip (Today's Follow Up)

Automates GDMS **Booking/Retail Mgt → Today's Follow Up**: Search, double-click each row, fill **Follow Up** tab, Save.

## Flow

1. Car sidebar (`li.nav_sal`)
2. **Booking/Retail Mgt** flyout
3. **Today's Follow Up** tree item
4. **Search** (top-right, next to Clear)
5. For each table row: double-click → **Follow Up** tab → remarks → type **P** + Enter on both follow-up type dropdowns → next day **9:30 PM** (Saturday → Monday) → **Save**

## Parallel with enquiry transfer

Uses a separate Chromium profile (`{dealerId}-follow-up-skip`) so enquiry transfer can run on `{dealerId}` at the same time.

## Settings

**Settings → Follow Up Skip**: toggle + daily IST start time. API scheduler enqueues one run per dealer per day at that time.

## Manual start

**Dashboard → Operation: Follow up skip → START** (no sources required).
