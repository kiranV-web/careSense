-- The fixed issue_category enum was missing several common, clearly-identifiable topics
-- (branch hours/location, appointment scheduling, credit report requests, replacement-card
-- status), so real calls about them were falling into the OTHER catch-all instead of being
-- classified. Add the missing categories, reclassify existing OTHER rows by their existing
-- title/short_description, and drop OTHER entirely so every call must get a real category.

ALTER TABLE call_recordings DROP CONSTRAINT IF EXISTS call_recordings_issue_category_check;

UPDATE call_recordings SET issue_category = CASE
  WHEN title ILIKE '%branch%' THEN 'BRANCH_HOURS_OR_LOCATION'
  WHEN title ILIKE '%appointment%' THEN 'APPOINTMENT_SCHEDULING'
  WHEN title ILIKE '%credit report%' THEN 'CREDIT_REPORT_REQUEST'
  WHEN title ILIKE '%replacement card%' OR title ILIKE '%card delay%' THEN 'CARD_REPLACEMENT_STATUS'
  WHEN short_description ILIKE '%branch%' THEN 'BRANCH_HOURS_OR_LOCATION'
  ELSE issue_category
END
WHERE issue_category = 'OTHER';

UPDATE recurring_call_groups SET issue_category = CASE
  WHEN group_title ILIKE '%branch%' THEN 'BRANCH_HOURS_OR_LOCATION'
  WHEN group_title ILIKE '%appointment%' THEN 'APPOINTMENT_SCHEDULING'
  WHEN group_title ILIKE '%credit report%' THEN 'CREDIT_REPORT_REQUEST'
  WHEN group_title ILIKE '%replacement card%' OR group_title ILIKE '%card delay%' THEN 'CARD_REPLACEMENT_STATUS'
  WHEN summary ILIKE '%branch%' THEN 'BRANCH_HOURS_OR_LOCATION'
  WHEN summary ILIKE '%appointment%' THEN 'APPOINTMENT_SCHEDULING'
  ELSE issue_category
END
WHERE issue_category = 'OTHER';

ALTER TABLE call_recordings ADD CONSTRAINT call_recordings_issue_category_check
  CHECK (issue_category IS NULL OR issue_category IN (
    'CHEQUEBOOK_REQUEST','CHEQUEBOOK_CHANGE','MONEY_TRANSFER','TRANSFER_FAILED','CARD_PAYMENT',
    'CASH_WITHDRAWAL','ACCOUNT_BALANCE','ACCOUNT_STATEMENT','BENEFICIARY_MANAGEMENT','UPI_PAYMENT',
    'ONLINE_BANKING','ACCOUNT_DETAILS_CHANGE','LOAN_ENQUIRY','INTEREST_AND_CHARGES','FRAUD_OR_SCAM',
    'CARD_LOST_OR_STOLEN','CARD_ACTIVATION','CARD_DECLINED','REFUND_PENDING',
    'BRANCH_HOURS_OR_LOCATION','APPOINTMENT_SCHEDULING','CREDIT_REPORT_REQUEST','CARD_REPLACEMENT_STATUS'
  ));
