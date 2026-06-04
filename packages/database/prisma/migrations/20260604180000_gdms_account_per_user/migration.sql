-- GDMS credentials: one account per user (TL/SC), not per dealer

ALTER TABLE "GdmsAccount" ADD COLUMN IF NOT EXISTS "userId" TEXT;

UPDATE "GdmsAccount" ga
SET "userId" = (
  SELECT u.id FROM "User" u
  WHERE u."dealerId" = ga."dealerId"
  ORDER BY
    CASE u.role::text
      WHEN 'DEALER_ADMIN' THEN 0
      WHEN 'TEAM_LEADER' THEN 1
      ELSE 2
    END,
    u."createdAt" ASC
  LIMIT 1
)
WHERE ga."userId" IS NULL;

DELETE FROM "GdmsAccount" WHERE "userId" IS NULL;

ALTER TABLE "GdmsAccount" DROP CONSTRAINT IF EXISTS "GdmsAccount_dealerId_fkey";
DROP INDEX IF EXISTS "GdmsAccount_dealerId_key";
ALTER TABLE "GdmsAccount" DROP COLUMN IF EXISTS "dealerId";

ALTER TABLE "GdmsAccount" ALTER COLUMN "userId" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "GdmsAccount_userId_key" ON "GdmsAccount"("userId");

ALTER TABLE "GdmsAccount" ADD CONSTRAINT "GdmsAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
