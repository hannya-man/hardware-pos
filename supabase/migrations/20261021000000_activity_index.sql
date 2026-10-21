-- Everyone's activity on the Audit log lists the activity of every person,
-- newest first, for a day, week or month: by time across all staff, which
-- the (actor_id, client_created_at) index doesn't cover. Safe to run again.
create index if not exists activity_log_time_idx on public.activity_log (client_created_at);
