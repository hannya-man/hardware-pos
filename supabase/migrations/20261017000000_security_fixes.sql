-- RRC Merchandise POS: security fixes. Safe to run more than once, like
-- 20261015000001_pos_api.sql: the "Update the database" workflow runs the
-- API file and then this one after every change to them (in the SQL Editor,
-- the same two, in that order).

-- What 20261016000000_security_controls.sql did, in a form that can run
-- twice, so a project is right whether or not that file was ever run on it.
alter table public.audit_logs add column if not exists ip_address text default pos.client_ip();
create index if not exists audit_logs_type_time_idx on public.audit_logs (action_type, client_created_at);

-- Every kind of audit event, including changes to owner accounts (made in
-- Supabase, or an owner deactivated by another).
alter table public.audit_logs drop constraint if exists audit_logs_action_type_check;
alter table public.audit_logs add constraint audit_logs_action_type_check check (action_type in (
  'void_item', 'void_sale', 'admin_void', 'refund', 'price_override',
  'manual_stock_adjustment', 'failed_pin_attempt', 'shift_close_discrepancy',
  'return_accepted', 'damage_reported', 'stock_transfer',
  'cycle_count_correction', 'day_close_discrepancy',
  'batch_oversold', 'timestamp_anomaly_clamped', 'customer_anonymized',
  'owner_account_changed'));

-- Tills used to keep each owner's two-factor secret; the server checks the
-- codes now (pos.check_pin). Marking every account as changed makes each
-- till fetch them again, this time without the secret.
update public.users set updated_at = now();
