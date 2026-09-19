-- DB-level CHECK constraints (Prisma's schema DSL has no CHECK support).
-- Applied as a migration AFTER the Prisma-generated tables exist.
-- These are the last line of defence; the API layer validates first.

-- Fees: no negative payments.
ALTER TABLE "FeePayment" ADD CONSTRAINT fee_payment_amount_nonnegative CHECK ("amount" >= 0);

-- Marks: VALUE marks must carry a score within [0, maxScore]; special marks
-- (ABS/MISSING/EXEMPT/NA) must carry NO score (they are never silently zero).
ALTER TABLE "Mark" ADD CONSTRAINT mark_value_score_bounds CHECK (
  ("type" = 'VALUE' AND "score" IS NOT NULL AND "score" >= 0 AND "score" <= "maxScore")
  OR
  ("type" <> 'VALUE' AND "score" IS NULL)
);

-- Term numbers: 1..3 per Ugandan school calendar.
ALTER TABLE "Term" ADD CONSTRAINT term_number_range CHECK ("number" BETWEEN 1 AND 3);

-- Attendance: counts can never be negative.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT attendance_nonnegative CHECK (
  "daysPresent" >= 0 AND "daysAbsent" >= 0 AND "daysTotal" >= 0
);

-- Fee structures: amounts non-negative.
ALTER TABLE "FeeStructure" ADD CONSTRAINT fee_structure_amount_nonnegative CHECK ("amount" >= 0);

-- Backups: size non-negative.
ALTER TABLE "BackupSnapshot" ADD CONSTRAINT backup_size_nonnegative CHECK ("sizeBytes" >= 0);

-- Invitations: single-use semantics at the DB level.
ALTER TABLE "Invitation" ADD CONSTRAINT invitation_single_use CHECK (
  "redeemedAt" IS NULL OR "revokedAt" IS NULL
);
