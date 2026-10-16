-- RRC Merchandise POS: security controls for ISO/IEC 27001 (see
-- docs/compliance). Run once, after the earlier files, then run
-- 20261015000001_pos_api.sql again: it has the functions that use these.

-- Where each audit event came from, filled in from the request, like the
-- activity log's ip_address. Informational: it comes from proxy headers.
alter table public.audit_logs add column ip_address text default pos.client_ip();

-- New audit event: a customer's name and phone removed on request
-- (pos.anonymize_customer), under the Data Privacy Act.
alter table public.audit_logs drop constraint audit_logs_action_type_check;
alter table public.audit_logs add constraint audit_logs_action_type_check check (action_type in (
  'void_item', 'void_sale', 'admin_void', 'refund', 'price_override',
  'manual_stock_adjustment', 'failed_pin_attempt', 'shift_close_discrepancy',
  'return_accepted', 'damage_reported', 'stock_transfer',
  'cycle_count_correction', 'day_close_discrepancy',
  'batch_oversold', 'timestamp_anomaly_clamped', 'customer_anonymized'));

-- The owners' Audit log screen reads newest first, by kind of event.
create index audit_logs_type_time_idx on public.audit_logs (action_type, client_created_at);
