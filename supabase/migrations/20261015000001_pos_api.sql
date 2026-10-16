-- RRC Merchandise POS: the API, as Postgres functions the app calls through
-- Supabase (POST /rest/v1/rpc/pos_...). It replaces the Laravel controllers
-- endpoint for endpoint, with the same checks and the same JSON.
--
-- Every API function takes (auth jsonb, args jsonb):
--   auth  { terminal_id, shift_id, terminal_key }  a device's own traffic:
--                                                  catalog pull, sync, sign-in
--         { terminal_id, shift_id, token }         a person's server sign-in
--   args  the request's fields
-- A refusal raises SQLSTATE PTxyz, which Supabase sends back as HTTP status
-- xyz with the message, the way Laravel's 401 / 403 / 422 answers worked.
--
-- Run after 20261015000000_pos_schema.sql. Safe to run again after editing:
-- everything here is "create or replace".

-- ===========================================================================
-- Small helpers
-- ===========================================================================

-- The store's clock, for "today" and "this week" on reports. Stored times
-- stay in UTC.
create or replace function pos.store_timezone() returns text
language sql immutable set search_path = '' as $$
  select 'Asia/Manila'
$$;

-- Stops the request with a message the app shows as it is.
create or replace function pos.fail(p_status integer, p_message text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'PT' || p_status::text, message = p_message;
end $$;

create or replace function pos.uuid_or_null(p_value text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_value::uuid end
$$;

create or replace function pos.number_or_null(p_value text) returns numeric
language sql immutable set search_path = '' as $$
  select case when p_value ~ '^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$' then p_value::numeric end
$$;

create or replace function pos.sha256_hex(p_value text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
$$;

-- Reading request fields. Each returns null when the field is missing or
-- blank, and refuses (422) a value of the wrong kind.

create or replace function pos.arg_uuid(p_args jsonb, p_key text, p_label text) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_raw text := nullif(btrim(p_args ->> p_key), '');
begin
  if v_raw is null then
    return null;
  end if;
  if pos.uuid_or_null(v_raw) is null then
    perform pos.fail(422, p_label || ' is not valid.');
  end if;
  return v_raw::uuid;
end $$;

create or replace function pos.arg_number(p_args jsonb, p_key text, p_label text, p_min numeric default null) returns numeric
language plpgsql set search_path = '' as $$
declare
  v_raw text := nullif(btrim(p_args ->> p_key), '');
  v_value numeric;
begin
  if v_raw is null then
    return null;
  end if;
  v_value := pos.number_or_null(v_raw);
  if v_value is null then
    perform pos.fail(422, p_label || ' must be a number.');
  end if;
  if p_min is not null and v_value < p_min then
    perform pos.fail(422, p_label || ' can''t be below ' || p_min::text || '.');
  end if;
  return v_value;
end $$;

create or replace function pos.arg_time(p_args jsonb, p_key text, p_label text) returns timestamptz
language plpgsql set search_path = '' as $$
declare
  v_raw text := nullif(btrim(p_args ->> p_key), '');
begin
  if v_raw is null then
    return null;
  end if;
  return v_raw::timestamptz;
exception when others then
  perform pos.fail(422, p_label || ' is not a valid date.');
  return null;
end $$;

create or replace function pos.arg_bool(p_args jsonb, p_key text, p_label text) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_raw text := lower(nullif(btrim(p_args ->> p_key), ''));
begin
  if v_raw is null then
    return null;
  end if;
  if v_raw in ('true', '1') then
    return true;
  end if;
  if v_raw in ('false', '0') then
    return false;
  end if;
  perform pos.fail(422, p_label || ' must be true or false.');
  return null;
end $$;

-- The connection's address, for the activity log. Informational only: it
-- comes from the proxy headers Supabase passes along.
create or replace function pos.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare
  v_headers jsonb;
begin
  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  return nullif(btrim(split_part(coalesce(
    v_headers ->> 'cf-connecting-ip', v_headers ->> 'x-real-ip', v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
exception when others then
  return null;
end $$;

-- ===========================================================================
-- Who is calling
-- ===========================================================================

-- Terminal keys are compared without spaces, dashes or case, so a key typed
-- as "abcd-efgh" or "ABCDEFGH" is the same key.
create or replace function pos.normalize_key(p_key text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_key, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- The device credential for routine sync. It proves "a registered device",
-- not who is signed in on it: who did what travels in the records themselves.
create or replace function pos.require_terminal(p_auth jsonb) returns public.terminals
language plpgsql set search_path = '' as $$
declare
  v_key text := pos.normalize_key(p_auth ->> 'terminal_key');
  v_terminal public.terminals;
begin
  if v_key = '' then
    perform pos.fail(401, 'Missing terminal key');
  end if;
  select * into v_terminal from public.terminals t
  where t.api_key_hash = pos.sha256_hex(v_key) and t.is_active;
  if not found then
    perform pos.fail(401, 'Unknown or deactivated terminal');
  end if;
  if v_terminal.last_seen_at is null or v_terminal.last_seen_at < now() - interval '1 minute' then
    update public.terminals set last_seen_at = now() where id = v_terminal.id;
  end if;
  return v_terminal;
end $$;

-- A person's server sign-in, made by pos_login from the password they typed
-- at the till. It lasts at most 12 hours (a long shift) and ends after 2
-- hours unused; the app then signs in again with the password typed at the
-- till, or asks for it. A deactivated account is refused even with an older
-- token.
create or replace function pos.require_user(p_auth jsonb) returns public.users
language plpgsql set search_path = '' as $$
declare
  v_token public.api_tokens;
  v_user public.users;
begin
  select * into v_token from public.api_tokens t
  where t.token_hash = pos.sha256_hex(coalesce(p_auth ->> 'token', ''));
  if not found then
    perform pos.fail(401, 'Not signed in to the server');
  end if;
  if v_token.created_at < now() - interval '12 hours' or v_token.last_used_at < now() - interval '2 hours' then
    perform pos.fail(401, 'Your server sign-in expired');
  end if;
  select * into v_user from public.users u where u.id = v_token.user_id and u.is_active;
  if not found then
    perform pos.fail(401, 'This account was deactivated');
  end if;
  if v_token.last_used_at < now() - interval '1 minute' then
    update public.api_tokens set last_used_at = now() where id = v_token.id;
  end if;
  return v_user;
end $$;

-- Owners run the store screens; cashiers sell, take credit payments, and
-- work the pick lists.
create or replace function pos.require_owner(p_auth jsonb) returns public.users
language plpgsql set search_path = '' as $$
declare
  v_user public.users := pos.require_user(p_auth);
begin
  if v_user.role <> 'owner' then
    perform pos.fail(403, 'Only an owner can do this.');
  end if;
  return v_user;
end $$;

-- Adds an entry to the shift's activity for something done on the server
-- (price change, staff edit, void, ...). It goes on the shift of whoever is
-- signed in at the terminal, when the server has that shift. p_actor is who
-- did it, which can be another owner approving at this screen. A logging
-- failure never becomes an error for the person saving.
create or replace function pos.record_activity(
  p_auth jsonb, p_actor uuid, p_event text, p_entity_type text, p_entity_id uuid, p_details jsonb default '{}'::jsonb
) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.activity_log (terminal_id, ip_address, actor_id, shift_id, event_type, entity_type, entity_id, details, client_created_at)
  values (
    coalesce(nullif(p_auth ->> 'terminal_id', ''), 'unknown'),
    pos.client_ip(),
    p_actor,
    (select s.id from public.shift_logs s where s.id = pos.uuid_or_null(p_auth ->> 'shift_id')),
    p_event, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb), now());
exception when others then
  raise warning 'activity log write failed (%): %', p_event, sqlerrm;
end $$;

-- ===========================================================================
-- Passwords and two-factor codes
-- ===========================================================================

create or replace function pos.hash_pin(p_pin text) returns text
language sql volatile set search_path = '' as $$
  select extensions.crypt(p_pin, extensions.gen_salt('bf', 12))
$$;

-- Laravel stored $2y$ hashes. pgcrypto only reads the $2a$ spelling of the
-- same hash (identical for digit passwords), so both are compared as $2a$.
create or replace function pos.pin_matches(p_pin text, p_hash text) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  v_hash text := regexp_replace(coalesce(p_hash, ''), '^\$2[by]\$', '$2a$');
begin
  if p_pin is null or v_hash !~ '^\$2a\$' then
    return false;
  end if;
  return extensions.crypt(p_pin, v_hash) = v_hash;
end $$;

-- Checks a typed password. Five wrong in a row lock the account for a
-- minute, then the count starts over. Returns null when it's right, or the
-- message to show. Callers hand that message back instead of raising it, so
-- the count of wrong tries, and the audit entry for each, are saved rather
-- than rolled back.
drop function if exists pos.check_pin(uuid, text);
create or replace function pos.check_pin(p_user_id uuid, p_pin text, p_auth jsonb default '{}'::jsonb) returns text
language plpgsql set search_path = '' as $$
declare
  v_user public.users;
  v_attempts integer;
begin
  select * into v_user from public.users u where u.id = p_user_id for update;
  if not found then
    return 'That password isn''t right — try again.';
  end if;
  if v_user.locked_until > now() then
    insert into public.audit_logs (terminal_id, action_type, entity_type, entity_id, details, client_created_at)
    values (coalesce(nullif(p_auth ->> 'terminal_id', ''), 'unknown'), 'failed_pin_attempt', 'user', v_user.id,
            jsonb_build_object('step', 'password', 'locked', true, 'checked', 'server'), now());
    return 'Too many attempts — try again in a minute.';
  end if;
  if not pos.pin_matches(p_pin, v_user.pin_hash) then
    v_attempts := (case when v_user.locked_until is not null then 0 else v_user.failed_pin_attempts end) + 1;
    update public.users
    set failed_pin_attempts = v_attempts,
        locked_until = case when v_attempts >= 5 then now() + interval '1 minute' end
    where id = v_user.id;
    insert into public.audit_logs (terminal_id, action_type, entity_type, entity_id, details, client_created_at)
    values (coalesce(nullif(p_auth ->> 'terminal_id', ''), 'unknown'), 'failed_pin_attempt', 'user', v_user.id,
            jsonb_build_object('step', 'password', 'attempt', v_attempts, 'locked', v_attempts >= 5, 'checked', 'server'), now());
    return 'That password isn''t right — try again.';
  end if;
  if v_user.failed_pin_attempts > 0 or v_user.locked_until is not null then
    update public.users set failed_pin_attempts = 0, locked_until = null where id = v_user.id;
  end if;
  return null;
end $$;

-- Owners get a 6-digit password, cashiers a 4-digit one.
create or replace function pos.assert_pin_length(p_pin text, p_role text) returns void
language plpgsql set search_path = '' as $$
declare
  v_expected integer := case when p_role = 'owner' then 6 else 4 end;
begin
  if length(p_pin) <> v_expected then
    perform pos.fail(422, case when p_role = 'owner' then 'An owner' else 'A cashier' end
      || ' account needs a ' || v_expected || '-digit password.');
  end if;
end $$;

create or replace function pos.base32_encode(p_bytes bytea) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_buffer bigint := 0;
  v_bits integer := 0;
  v_out text := '';
begin
  for i in 0 .. length(p_bytes) - 1 loop
    v_buffer := (v_buffer << 8) | get_byte(p_bytes, i);
    v_bits := v_bits + 8;
    while v_bits >= 5 loop
      v_out := v_out || substr(v_alphabet, ((v_buffer >> (v_bits - 5)) & 31)::integer + 1, 1);
      v_bits := v_bits - 5;
    end loop;
    v_buffer := v_buffer & ((1::bigint << v_bits) - 1);
  end loop;
  if v_bits > 0 then
    v_out := v_out || substr(v_alphabet, ((v_buffer << (5 - v_bits)) & 31)::integer + 1, 1);
  end if;
  return v_out;
end $$;

create or replace function pos.base32_decode(p_text text) returns bytea
language plpgsql immutable set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_buffer bigint := 0;
  v_bits integer := 0;
  v_out bytea := ''::bytea;
  v_char text;
  v_value integer;
begin
  foreach v_char in array string_to_array(upper(rtrim(coalesce(p_text, ''), '=')), null) loop
    v_value := strpos(v_alphabet, v_char) - 1;
    continue when v_value < 0;
    v_buffer := (v_buffer << 5) | v_value;
    v_bits := v_bits + 5;
    if v_bits >= 8 then
      v_out := v_out || decode(lpad(to_hex((v_buffer >> (v_bits - 8)) & 255), 2, '0'), 'hex');
      v_bits := v_bits - 8;
      v_buffer := v_buffer & ((1::bigint << v_bits) - 1);
    end if;
  end loop;
  return v_out;
end $$;

-- One 6-digit code (RFC 6238), the same as TotpService.php and totp.js.
create or replace function pos.totp_code(p_secret text, p_counter bigint) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_hash bytea := extensions.hmac(int8send(p_counter), pos.base32_decode(p_secret), 'sha1');
  v_offset integer := get_byte(v_hash, 19) & 15;
  v_value bigint;
begin
  v_value := ((get_byte(v_hash, v_offset) & 127)::bigint << 24)
           | (get_byte(v_hash, v_offset + 1)::bigint << 16)
           | (get_byte(v_hash, v_offset + 2)::bigint << 8)
           | get_byte(v_hash, v_offset + 3)::bigint;
  return lpad((v_value % 1000000)::text, 6, '0');
end $$;

-- The current 30-second code, or the one just before or after it, to allow
-- for the phone's clock and the time it takes to type.
create or replace function pos.totp_verify(p_secret text, p_code text) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  v_code text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  v_counter bigint := floor(extract(epoch from now()) / 30)::bigint;
begin
  if p_secret is null or length(v_code) <> 6 then
    return false;
  end if;
  for v_step in -1 .. 1 loop
    if pos.totp_code(p_secret, v_counter + v_step) = v_code then
      return true;
    end if;
  end loop;
  return false;
end $$;

create or replace function pos.url_encode(p_text text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(
    case when b between 48 and 57 or b between 65 and 90 or b between 97 and 122 or b in (45, 46, 95, 126)
      then chr(b) else '%' || upper(lpad(to_hex(b), 2, '0')) end, '' order by i), '')
  from (select i, get_byte(convert_to(p_text, 'UTF8'), i) as b
        from generate_series(0, octet_length(convert_to(p_text, 'UTF8')) - 1) as i) bytes
$$;

-- ===========================================================================
-- Stock
-- ===========================================================================

-- Sets a product's good quantity at one location to an exact number. The
-- difference goes through the batch ledger like every other stock change:
-- an increase opens a new batch, a decrease draws down the oldest batches
-- first. Returns the change.
create or replace function pos.set_stock(
  p_product uuid, p_location text, p_quantity numeric, p_actor uuid, p_note text,
  p_increase_reason text default 'stocktake_correction'
) returns numeric
language plpgsql set search_path = '' as $$
declare
  v_current numeric;
  v_delta numeric;
  v_remaining numeric;
  v_take numeric;
  v_batch record;
  v_batch_id uuid;
begin
  select coalesce(sum(b.qty_good_remaining), 0) into v_current
  from public.stock_batches b where b.product_id = p_product and b.location = p_location;
  v_delta := round(p_quantity - v_current, 3);

  if v_delta > 0 then
    insert into public.stock_batches (product_id, location, received_at, qty_received, qty_good_remaining, qty_damaged, source, created_by, client_created_at)
    values (p_product, p_location, now(), v_delta, v_delta, 0, 'receiving', p_actor, now())
    returning id into v_batch_id;
    insert into public.stock_movements (product_id, batch_id, delta, reason, reference_id, actor_id, note, client_created_at)
    values (p_product, v_batch_id, v_delta, p_increase_reason, v_batch_id, p_actor, p_note, now());
  elsif v_delta < 0 then
    v_remaining := -v_delta;
    for v_batch in
      select b.id, b.qty_good_remaining from public.stock_batches b
      where b.product_id = p_product and b.location = p_location and b.qty_good_remaining > 0
      order by b.received_at
      for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, v_batch.qty_good_remaining);
      update public.stock_batches set qty_good_remaining = qty_good_remaining - v_take where id = v_batch.id;
      insert into public.stock_movements (product_id, batch_id, delta, reason, reference_id, actor_id, note, client_created_at)
      values (p_product, v_batch.id, -v_take, 'stocktake_correction', v_batch.id, p_actor, p_note, now());
      v_remaining := round(v_remaining - v_take, 3);
    end loop;

    if v_remaining > 0.001 then
      -- Asked for less than zero at this location: record what couldn't apply.
      insert into public.audit_logs (terminal_id, actor_id, action_type, entity_type, entity_id, details, client_created_at)
      values ('admin-app', p_actor, 'manual_stock_adjustment', 'product', p_product,
              jsonb_build_object('location', p_location, 'short_by', v_remaining, 'note', p_note), now());
    end if;
  end if;

  return v_delta;
end $$;

-- ===========================================================================
-- JSON the screens expect (the shapes Laravel sent)
-- ===========================================================================

create or replace function pos.user_brief(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', u.id, 'full_name', u.full_name) from public.users u where u.id = p_id
$$;

-- A staff account without its password hash or two-factor secret.
create or replace function pos.user_json(p_user public.users) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(p_user) - 'pin_hash' - 'totp_secret'
$$;

create or replace function pos.sale_items_json(p_sale_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'sale_id', i.sale_id, 'name_snapshot', i.name_snapshot, 'quantity', i.quantity,
      'unit_price_snapshot', i.unit_price_snapshot, 'line_total', i.line_total) order by i.seq), '[]'::jsonb)
  from public.sale_items i where i.sale_id = p_sale_id
$$;

-- A sale with its items, the cashier, and the credit customer (if any).
create or replace function pos.sale_json(p_sale public.sales) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(p_sale) || jsonb_build_object(
    'cashier', pos.user_brief(p_sale.cashier_id),
    'customer', (select jsonb_build_object('id', c.id, 'name', c.name) from public.customers c where c.id = p_sale.customer_id),
    'items', pos.sale_items_json(p_sale.id))
$$;

-- What's still unpaid on completed credit sales, minus everything paid back
-- since. A voided sale drops out on its own.
create or replace function pos.customer_owed(p_customer uuid) returns numeric
language sql stable set search_path = '' as $$
  select round(
    coalesce((select sum(s.total_amount - coalesce(s.amount_paid, 0)) from public.sales s
              where s.customer_id = p_customer and s.payment_method = 'credit' and s.status = 'completed'), 0)
    - coalesce((select sum(p.amount) from public.credit_payments p where p.customer_id = p_customer), 0), 2)
$$;

-- A pick list with who sent it, who picked it up, and its sale.
create or replace function pos.material_request_json(p_request public.material_requests) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(p_request) || jsonb_build_object(
    'requested_by', pos.user_brief(p_request.requested_by),
    'fulfilled_by', pos.user_brief(p_request.fulfilled_by),
    'sale', (select jsonb_build_object(
               'id', s.id, 'payment_method', s.payment_method, 'customer_id', s.customer_id, 'status', s.status,
               'customer', (select jsonb_build_object('id', c.id, 'name', c.name) from public.customers c where c.id = s.customer_id))
             from public.sales s where s.id = p_request.sale_id))
$$;

-- What an audit event is about, in words: the person, item, shift or sale.
create or replace function pos.audit_subject(p_type text, p_id uuid) returns text
language sql stable set search_path = '' as $$
  select case p_type
    when 'user' then (select u.full_name from public.users u where u.id = p_id)
    when 'product' then (select p.name from public.products p where p.id = p_id)
    when 'stock_batch' then (select p.name from public.stock_batches b join public.products p on p.id = b.product_id where b.id = p_id)
    when 'sales_return' then (select p.name from public.sales_returns r join public.products p on p.id = r.product_id where r.id = p_id)
    when 'shift_log' then (select u.full_name from public.shift_logs s join public.users u on u.id = s.cashier_id where s.id = p_id)
    when 'customer' then (select c.name from public.customers c where c.id = p_id)
    when 'sale' then upper(left(p_id::text, 8))
  end
$$;

-- Laravel's paginate() shape, which the screens read .data from.
create or replace function pos.page_json(p_rows jsonb, p_total bigint, p_page integer, p_per_page integer) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'current_page', p_page,
    'data', coalesce(p_rows, '[]'::jsonb),
    'from', case when p_total > 0 and (p_page - 1) * p_per_page < p_total then (p_page - 1) * p_per_page + 1 end,
    'to', case when p_total > 0 and (p_page - 1) * p_per_page < p_total then least(p_page * p_per_page, p_total) end,
    'last_page', greatest(1, ceil(p_total::numeric / p_per_page)::integer),
    'per_page', p_per_page,
    'total', p_total)
$$;

-- ===========================================================================
-- Voids: two owners have to say yes within 10 minutes
-- ===========================================================================

-- Requests are marked expired the next time anyone looks, so nothing has to
-- run on a timer. Until then an overdue one already counts as lapsed.
create or replace function pos.expire_overdue_voids() returns void
language sql set search_path = '' as $$
  update public.void_requests set status = 'expired', resolved_at = expires_at
  where status = 'pending' and expires_at <= now()
$$;

create or replace function pos.present_void(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', v.id,
    'status', case when v.status = 'pending' and v.expires_at <= now() then 'expired' else v.status end,
    'reason', v.reason,
    -- Counted here, so a device with a wrong clock still shows the right time left.
    'seconds_left', case when v.status = 'pending' and v.expires_at > now()
                      then floor(extract(epoch from v.expires_at - now()))::integer else 0 end,
    'approvals_needed', 2,
    'requested_by', pos.user_brief(v.requested_by),
    'resolved_by', pos.user_brief(v.resolved_by),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'full_name', u.full_name) order by a.id)
      from public.void_request_approvals a left join public.users u on u.id = a.user_id
      where a.void_request_id = v.id), '[]'::jsonb),
    'sale', (
      select jsonb_build_object(
        'id', s.id, 'status', s.status, 'total_amount', s.total_amount, 'payment_method', s.payment_method,
        'client_created_at', s.client_created_at,
        'cashier', pos.user_brief(s.cashier_id),
        'customer', (select jsonb_build_object('id', c.id, 'name', c.name) from public.customers c where c.id = s.customer_id),
        'items', pos.sale_items_json(s.id))
      from public.sales s where s.id = v.sale_id))
  from public.void_requests v where v.id = p_id
$$;

-- The request, locked so two owners approving at the same moment can't both
-- void the sale. Says why when it's no longer open.
create or replace function pos.lock_open_void(p_id uuid) returns public.void_requests
language plpgsql set search_path = '' as $$
declare
  v_request public.void_requests;
begin
  select * into v_request from public.void_requests v where v.id = p_id for update;
  if not found then
    perform pos.fail(404, 'That void request no longer exists.');
  end if;
  if v_request.status = 'approved' then
    perform pos.fail(422, 'This sale was already voided.');
  elsif v_request.status = 'rejected' then
    perform pos.fail(422, 'Another owner already said no to this void.');
  elsif v_request.status = 'cancelled' then
    perform pos.fail(422, 'This void request was cancelled.');
  elsif v_request.status = 'expired' or v_request.expires_at <= now() then
    perform pos.fail(422, 'This void request expired, so the sale was not voided.');
  end if;
  return v_request;
end $$;

-- Puts the stock back (an offsetting void_restock movement per original sale
-- movement, into the same batches), cancels the sale's pick list, and records
-- who asked and who agreed. A voided credit sale stops counting toward the
-- customer's balance on its own.
create or replace function pos.void_sale(p_auth jsonb, p_request public.void_requests, p_owner public.users) returns void
language plpgsql set search_path = '' as $$
declare
  v_sale public.sales;
  v_move public.stock_movements;
begin
  select * into v_sale from public.sales s where s.id = p_request.sale_id for update;
  if not found or v_sale.status <> 'completed' then
    perform pos.fail(422, 'This sale is no longer a completed sale.');
  end if;

  update public.sales set status = 'voided', voided_by = p_request.requested_by, void_reason = p_request.reason
  where id = v_sale.id;

  -- Its pick list, if the items weren't picked up yet: don't hand them over.
  update public.material_requests set status = 'cancelled' where sale_id = v_sale.id and status = 'pending';

  for v_move in
    select * from public.stock_movements m where m.reference_id = v_sale.id and m.reason = 'sale'
  loop
    insert into public.stock_movements (product_id, batch_id, terminal_id, delta, reason, reference_id, actor_id, client_created_at)
    values (v_move.product_id, v_move.batch_id, v_move.terminal_id, abs(v_move.delta), 'void_restock', v_sale.id, p_owner.id, now());
    if v_move.batch_id is not null then
      update public.stock_batches set qty_good_remaining = qty_good_remaining + abs(v_move.delta) where id = v_move.batch_id;
    end if;
  end loop;

  insert into public.audit_logs (terminal_id, actor_id, approver_id, action_type, entity_type, entity_id, details, client_created_at)
  values (
    coalesce(nullif(p_auth ->> 'terminal_id', ''), 'unknown'), p_request.requested_by, p_owner.id, 'admin_void', 'sale', v_sale.id,
    jsonb_build_object(
      'reason', p_request.reason,
      'total_amount', v_sale.total_amount::text,
      'approved_by', (select jsonb_agg(a.user_id order by a.id) from public.void_request_approvals a where a.void_request_id = p_request.id)),
    now());
end $$;

-- One owner's yes. The second yes from an active owner voids the sale.
create or replace function pos.approve_void_as(p_auth jsonb, p_id uuid, p_owner public.users) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_request public.void_requests;
  v_yes integer;
  v_voided boolean := false;
  v_details jsonb;
begin
  perform pos.expire_overdue_voids();
  v_request := pos.lock_open_void(p_id);

  if exists (select 1 from public.void_request_approvals a where a.void_request_id = v_request.id and a.user_id = p_owner.id) then
    perform pos.fail(422, p_owner.full_name || ' already said yes. A different owner has to approve it.');
  end if;
  insert into public.void_request_approvals (void_request_id, user_id) values (v_request.id, p_owner.id);

  -- Only yeses from people who are still active owners count.
  select count(*) into v_yes
  from public.void_request_approvals a join public.users u on u.id = a.user_id
  where a.void_request_id = v_request.id and u.role = 'owner' and u.is_active;

  if v_yes >= 2 then
    perform pos.void_sale(p_auth, v_request, p_owner);
    update public.void_requests set status = 'approved', resolved_by = p_owner.id, resolved_at = now() where id = v_request.id;
    v_voided := true;
  end if;

  select jsonb_build_object('total_amount', s.total_amount::text, 'reason', v_request.reason) into v_details
  from public.sales s where s.id = v_request.sale_id;
  if v_voided then
    v_details := v_details || jsonb_build_object('approved_by', (
      select string_agg(u.full_name, ' and ' order by a.id)
      from public.void_request_approvals a join public.users u on u.id = a.user_id
      where a.void_request_id = v_request.id));
  end if;
  perform pos.record_activity(p_auth, p_owner.id, case when v_voided then 'sale_voided' else 'void_approved' end,
    'sale', v_request.sale_id, v_details);

  return pos.present_void(v_request.id);
end $$;

-- ===========================================================================
-- Sync push: what terminals saved offline
-- ===========================================================================

-- A sale from a terminal has to hang together before it's accepted. The
-- terminal can't decide a sale is voided (voids need two owners), its total
-- must be what its lines add up to, and its stock movements must belong to
-- it. The app always sends sales like this; anything else was tampered with
-- or broken, and is refused (the terminal then shows it as not synced).
create or replace function pos.check_sale(p_payload jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_sale jsonb := p_payload -> 'sale';
  v_id text := p_payload -> 'sale' ->> 'id';
  v_total numeric := (p_payload -> 'sale' ->> 'total_amount')::numeric;
  v_lines numeric;
  v_problem text;
begin
  if coalesce(v_sale ->> 'status', 'completed') <> 'completed'
     or v_sale ->> 'voided_by' is not null or v_sale ->> 'void_reason' is not null then
    raise exception 'A sale arrives as completed; voiding it needs two owners.';
  end if;
  if jsonb_typeof(p_payload -> 'items') is distinct from 'array' or jsonb_array_length(p_payload -> 'items') = 0 then
    raise exception 'A sale needs at least one line.';
  end if;

  select case
      when bool_or(i ->> 'sale_id' is distinct from v_id) then 'A sale line belongs to another sale.'
      when bool_or(coalesce((i ->> 'quantity')::numeric, 0) <= 0) then 'A sale line has no quantity.'
      when bool_or(abs((i ->> 'unit_price_snapshot')::numeric * (i ->> 'quantity')::numeric
                       - coalesce((i ->> 'line_discount')::numeric, 0) - (i ->> 'line_total')::numeric) > 0.01)
        then 'A sale line''s total doesn''t match its price and quantity.'
    end,
    sum((i ->> 'line_total')::numeric)
  into v_problem, v_lines
  from jsonb_array_elements(p_payload -> 'items') as i;
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;
  if v_total is null or abs(v_lines - v_total) > 0.01 then
    raise exception 'The sale''s total doesn''t match its lines.';
  end if;

  if v_sale ->> 'payment_method' = 'credit' and v_sale ->> 'customer_id' is null then
    raise exception 'A credit sale needs its customer.';
  end if;
  if coalesce((v_sale ->> 'amount_paid')::numeric, v_total) not between 0 and v_total + 0.01 then
    raise exception 'The amount paid is more than the sale.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_payload -> 'movements', '[]'::jsonb)) as m
    where m ->> 'reference_id' is distinct from v_id
       or coalesce(m ->> 'reason', 'sale') <> 'sale'
       or coalesce((m ->> 'delta')::numeric, 0) >= 0
       or not exists (select 1 from jsonb_array_elements(p_payload -> 'items') as i where i ->> 'product_id' = m ->> 'product_id'))
  then
    raise exception 'A stock movement doesn''t belong to this sale.';
  end if;
end $$;

-- A completed sale is three things at once (the sale, its lines, and the
-- stock it drew down), written together so stock is never taken without a
-- sale or the reverse. The FIFO choice was made on the terminal; this applies
-- it. Insert-only: a resend must not overwrite a sale voided here since.
create or replace function pos.push_sale(p_payload jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_sale jsonb := p_payload -> 'sale';
  v_item jsonb;
  v_move jsonb;
  v_batch_id uuid;
  v_left numeric;
begin
  perform pos.check_sale(p_payload);

  insert into public.sales (id, terminal_id, cashier_id, shift_id, subtotal, discount_amount, tax_amount,
    total_amount, payment_method, amount_tendered, change_amount, amount_paid, payment_reference,
    customer_id, status, voided_by, void_reason, client_created_at)
  values (
    (v_sale ->> 'id')::uuid,
    v_sale ->> 'terminal_id',
    (v_sale ->> 'cashier_id')::uuid,
    (v_sale ->> 'shift_id')::uuid,
    (v_sale ->> 'subtotal')::numeric,
    coalesce((v_sale ->> 'discount_amount')::numeric, 0),
    coalesce((v_sale ->> 'tax_amount')::numeric, 0),
    (v_sale ->> 'total_amount')::numeric,
    coalesce(v_sale ->> 'payment_method', 'cash'),
    (v_sale ->> 'amount_tendered')::numeric,
    (v_sale ->> 'change_amount')::numeric,
    (v_sale ->> 'amount_paid')::numeric,
    v_sale ->> 'payment_reference',
    (v_sale ->> 'customer_id')::uuid,
    coalesce(v_sale ->> 'status', 'completed'),
    (v_sale ->> 'voided_by')::uuid,
    v_sale ->> 'void_reason',
    (v_sale ->> 'client_created_at')::timestamptz)
  on conflict (id) do nothing;

  for v_item in
    select e.value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) with ordinality as e(value, n) order by e.n
  loop
    insert into public.sale_items (id, sale_id, product_id, sku_snapshot, name_snapshot, unit_price_snapshot,
      quantity, line_discount, line_total, voided_at, voided_by)
    values (
      (v_item ->> 'id')::uuid,
      (v_item ->> 'sale_id')::uuid,
      (v_item ->> 'product_id')::uuid,
      v_item ->> 'sku_snapshot',
      v_item ->> 'name_snapshot',
      (v_item ->> 'unit_price_snapshot')::numeric,
      (v_item ->> 'quantity')::numeric,
      coalesce((v_item ->> 'line_discount')::numeric, 0),
      (v_item ->> 'line_total')::numeric,
      (v_item ->> 'voided_at')::timestamptz,
      (v_item ->> 'voided_by')::uuid)
    on conflict (id) do nothing;
  end loop;

  for v_move in
    select e.value from jsonb_array_elements(coalesce(p_payload -> 'movements', '[]'::jsonb)) with ordinality as e(value, n) order by e.n
  loop
    -- Applied on an earlier attempt: don't take the stock twice.
    continue when exists (select 1 from public.stock_movements m where m.id = (v_move ->> 'id')::uuid);

    -- A batch this server never received (a stale terminal copy) shouldn't
    -- block the sale; the movement is kept unallocated.
    v_batch_id := pos.uuid_or_null(v_move ->> 'batch_id');
    if v_batch_id is not null and not exists (select 1 from public.stock_batches b where b.id = v_batch_id) then
      v_batch_id := null;
    end if;

    insert into public.stock_movements (id, product_id, batch_id, terminal_id, delta, reason, reference_id, actor_id, note, client_created_at)
    values (
      (v_move ->> 'id')::uuid, (v_move ->> 'product_id')::uuid, v_batch_id, v_move ->> 'terminal_id',
      (v_move ->> 'delta')::numeric, coalesce(v_move ->> 'reason', 'sale'), (v_move ->> 'reference_id')::uuid,
      (v_move ->> 'actor_id')::uuid, v_move ->> 'note', (v_move ->> 'client_created_at')::timestamptz);

    continue when v_batch_id is null;

    -- The row lock serializes two online terminals drawing from one batch.
    -- Two offline ones may both have sold from it; the sale already happened,
    -- so it's applied and the oversell is flagged for the owner.
    update public.stock_batches set qty_good_remaining = qty_good_remaining + (v_move ->> 'delta')::numeric
    where id = v_batch_id
    returning qty_good_remaining into v_left;

    if v_left < 0 then
      insert into public.audit_logs (terminal_id, actor_id, action_type, entity_type, entity_id, details, client_created_at)
      values (coalesce(v_sale ->> 'terminal_id', 'unknown'), (v_move ->> 'actor_id')::uuid, 'batch_oversold', 'stock_batch', v_batch_id,
              jsonb_build_object('oversold_by', abs(v_left), 'movement_id', v_move ->> 'id'),
              (v_move ->> 'client_created_at')::timestamptz);
    end if;
  end loop;
end $$;

-- A delivery added at a terminal. A device with a wrong clock could date a
-- batch next month, and it would never look "oldest" for FIFO, so anything
-- more than a few hours ahead is clamped to now, and logged. Insert-only: a
-- resend must not reset a batch that sales have drawn from since.
create or replace function pos.push_stock_batch(p_payload jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_id uuid := (p_payload ->> 'id')::uuid;
  v_received timestamptz := coalesce((p_payload ->> 'received_at')::timestamptz, now());
  v_batch public.stock_batches;
begin
  if exists (select 1 from public.stock_batches b where b.id = v_id) then
    return;
  end if;
  -- Terminals only receive deliveries: good plus damaged is what arrived.
  if coalesce(p_payload ->> 'source', 'receiving') <> 'receiving'
     or (p_payload ->> 'qty_received')::numeric <= 0
     or (p_payload ->> 'qty_good_remaining')::numeric < 0
     or coalesce((p_payload ->> 'qty_damaged')::numeric, 0) < 0
     or abs((p_payload ->> 'qty_good_remaining')::numeric + coalesce((p_payload ->> 'qty_damaged')::numeric, 0)
            - (p_payload ->> 'qty_received')::numeric) > 0.001 then
    raise exception 'A delivery''s good and damaged counts must add up to what was received.';
  end if;

  if v_received > now() + interval '6 hours' then
    insert into public.audit_logs (terminal_id, actor_id, action_type, entity_type, entity_id, details, client_created_at)
    values (coalesce(p_payload ->> 'terminal_id', 'unknown'), (p_payload ->> 'created_by')::uuid, 'timestamp_anomaly_clamped',
            'stock_batch', v_id, jsonb_build_object('claimed_received_at', p_payload ->> 'received_at', 'clamped_to', now()), now());
    v_received := now();
  end if;

  insert into public.stock_batches (id, product_id, location, received_at, qty_received, qty_good_remaining,
    qty_damaged, source, reference_id, created_by, client_created_at)
  values (
    v_id, (p_payload ->> 'product_id')::uuid, p_payload ->> 'location', v_received,
    (p_payload ->> 'qty_received')::numeric, (p_payload ->> 'qty_good_remaining')::numeric,
    coalesce((p_payload ->> 'qty_damaged')::numeric, 0), coalesce(p_payload ->> 'source', 'receiving'),
    (p_payload ->> 'reference_id')::uuid, (p_payload ->> 'created_by')::uuid,
    coalesce((p_payload ->> 'client_created_at')::timestamptz, now()))
  returning * into v_batch;

  -- Receiving counts as "items in" for the day, through a stock_receipt movement.
  if not exists (select 1 from public.stock_movements m where m.reference_id = v_batch.id and m.reason = 'stock_receipt') then
    insert into public.stock_movements (product_id, batch_id, terminal_id, delta, reason, reference_id, actor_id, client_created_at)
    values (v_batch.product_id, v_batch.id, p_payload ->> 'terminal_id', v_batch.qty_good_remaining + v_batch.qty_damaged,
            'stock_receipt', v_batch.id, v_batch.created_by, v_batch.client_created_at);
  end if;
end $$;

-- One outbox item. Logs, payments and pick lists are insert-only (a retried
-- push is a no-op, never an overwrite; a pick list's status only changes
-- here). Shifts and customers can change later on the terminal, so their
-- fields are updated, but only the ones the item carries. Each kind is
-- checked against what the app sends, so a tampered terminal can't record
-- what only the server or two owners may decide.
create or replace function pos.push_one(p_type text, p_payload jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_id uuid := (p_payload ->> 'id')::uuid;
  v_status text;
  v_sale_id uuid;
begin
  case p_type
  when 'sale' then
    perform pos.push_sale(p_payload);

  when 'stock_batch' then
    perform pos.push_stock_batch(p_payload);

  when 'shift_log' then
    -- A late copy of a shift's start can't reopen a shift that already ended.
    update public.shift_logs t set
      terminal_id = case when p_payload ? 'terminal_id' then p_payload ->> 'terminal_id' else t.terminal_id end,
      cashier_id = case when p_payload ? 'cashier_id' then (p_payload ->> 'cashier_id')::uuid else t.cashier_id end,
      started_at = case when p_payload ? 'started_at' then (p_payload ->> 'started_at')::timestamptz else t.started_at end,
      ended_at = case when p_payload ? 'ended_at' then (p_payload ->> 'ended_at')::timestamptz else t.ended_at end,
      opening_cash = case when p_payload ? 'opening_cash' then (p_payload ->> 'opening_cash')::numeric else t.opening_cash end,
      expected_cash = case when p_payload ? 'expected_cash' then (p_payload ->> 'expected_cash')::numeric else t.expected_cash end,
      counted_cash = case when p_payload ? 'counted_cash' then (p_payload ->> 'counted_cash')::numeric else t.counted_cash end,
      cash_discrepancy = case when p_payload ? 'cash_discrepancy' then (p_payload ->> 'cash_discrepancy')::numeric else t.cash_discrepancy end,
      status = case when p_payload ? 'status' then p_payload ->> 'status' else t.status end
    where t.id = v_id and (t.status = 'open' or p_payload ->> 'status' = 'closed');
    if not found and not exists (select 1 from public.shift_logs t where t.id = v_id) then
      insert into public.shift_logs (id, terminal_id, cashier_id, started_at, ended_at, opening_cash,
        expected_cash, counted_cash, cash_discrepancy, status)
      values (
        v_id, p_payload ->> 'terminal_id', (p_payload ->> 'cashier_id')::uuid,
        (p_payload ->> 'started_at')::timestamptz, (p_payload ->> 'ended_at')::timestamptz,
        coalesce((p_payload ->> 'opening_cash')::numeric, 0), (p_payload ->> 'expected_cash')::numeric,
        (p_payload ->> 'counted_cash')::numeric, (p_payload ->> 'cash_discrepancy')::numeric,
        coalesce(p_payload ->> 'status', 'open'));
    end if;

  when 'customer' then
    update public.customers t set
      name = case when p_payload ? 'name' then p_payload ->> 'name' else t.name end,
      phone = case when p_payload ? 'phone' then p_payload ->> 'phone' else t.phone end,
      is_active = case when p_payload ? 'is_active' then (p_payload ->> 'is_active')::boolean else t.is_active end
    where t.id = v_id;
    if not found then
      insert into public.customers (id, name, phone, is_active)
      values (v_id, p_payload ->> 'name', p_payload ->> 'phone', coalesce((p_payload ->> 'is_active')::boolean, true));
    end if;

  when 'sale_item', 'stock_movement' then
    -- Sale lines and stock movements only ever arrive inside their sale,
    -- checked together. On their own they could rewrite a sale after the fact.
    raise exception 'A % only arrives as part of its sale.', p_type;

  when 'activity_log' then
    -- The device isn't a trustworthy source for its own address, so it's
    -- taken from the connection that delivered this sync.
    insert into public.activity_log (id, terminal_id, ip_address, actor_id, shift_id, event_type, entity_type, entity_id, details, client_created_at)
    values (
      v_id, coalesce(p_payload ->> 'terminal_id', 'unknown'), pos.client_ip(), (p_payload ->> 'actor_id')::uuid,
      (p_payload ->> 'shift_id')::uuid, p_payload ->> 'event_type', p_payload ->> 'entity_type',
      pos.uuid_or_null(p_payload ->> 'entity_id'), nullif(p_payload -> 'details', 'null'::jsonb),
      (p_payload ->> 'client_created_at')::timestamptz)
    on conflict (id) do nothing;

  when 'audit_log' then
    -- A terminal only reports what it checks itself; everything else on the
    -- audit log is written by the server.
    if p_payload ->> 'action_type' is null or p_payload ->> 'action_type' not in ('shift_close_discrepancy', 'failed_pin_attempt') then
      raise exception 'A terminal can''t record a "%" audit event.', p_payload ->> 'action_type';
    end if;
    insert into public.audit_logs (id, terminal_id, actor_id, approver_id, action_type, entity_type, entity_id, details, client_created_at)
    values (
      v_id, coalesce(p_payload ->> 'terminal_id', 'unknown'), (p_payload ->> 'actor_id')::uuid, (p_payload ->> 'approver_id')::uuid,
      p_payload ->> 'action_type', p_payload ->> 'entity_type', pos.uuid_or_null(p_payload ->> 'entity_id'),
      nullif(p_payload -> 'details', 'null'::jsonb), (p_payload ->> 'client_created_at')::timestamptz)
    on conflict (id) do nothing;

  when 'credit_payment' then
    if coalesce((p_payload ->> 'amount')::numeric, 0) <= 0 then
      raise exception 'A payment needs an amount above zero.';
    end if;
    if p_payload ->> 'payment_method' is null or p_payload ->> 'payment_method' not in ('cash', 'gcash', 'bank') then
      raise exception 'A payment is cash, GCash or bank transfer.';
    end if;
    insert into public.credit_payments (id, customer_id, amount, payment_method, reference, note, terminal_id, shift_id, received_by, client_created_at)
    values (
      v_id, (p_payload ->> 'customer_id')::uuid, (p_payload ->> 'amount')::numeric, p_payload ->> 'payment_method',
      p_payload ->> 'reference', p_payload ->> 'note', p_payload ->> 'terminal_id', (p_payload ->> 'shift_id')::uuid,
      (p_payload ->> 'received_by')::uuid, (p_payload ->> 'client_created_at')::timestamptz)
    on conflict (id) do nothing;

  when 'material_request' then
    -- A new list is waiting to be picked; only the server marks it picked
    -- up. One arriving after its sale was voided has nothing to hand over.
    v_status := 'pending';
    v_sale_id := pos.uuid_or_null(p_payload ->> 'sale_id');
    if v_sale_id is not null and exists (select 1 from public.sales s where s.id = v_sale_id and s.status = 'voided') then
      v_status := 'cancelled';
    end if;
    insert into public.material_requests (id, terminal_id, sale_id, requested_by, items, status, notes, client_created_at)
    values (
      v_id, p_payload ->> 'terminal_id', v_sale_id, (p_payload ->> 'requested_by')::uuid,
      coalesce(nullif(p_payload -> 'items', 'null'::jsonb), '[]'::jsonb), v_status, p_payload ->> 'notes',
      (p_payload ->> 'client_created_at')::timestamptz)
    on conflict (id) do nothing;

  else
    raise exception 'unknown entity_type: %', p_type;
  end case;
end $$;

-- ===========================================================================
-- Owner tools, for the Supabase SQL Editor (the app can't reach these):
--
--   select pos.add_staff('Maria Santos', 'owner', '123456');
--   select pos.add_terminal('Front counter');
--   select pos.anonymize_customer('<customer id>');
-- ===========================================================================

create or replace function pos.add_staff(p_full_name text, p_role text, p_pin text) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
begin
  if btrim(coalesce(p_full_name, '')) = '' then
    raise exception 'Give the person a name.';
  end if;
  if p_role is null or p_role not in ('cashier', 'owner') then
    raise exception 'The role is either cashier or owner.';
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]+$' then
    raise exception 'The password is digits only.';
  end if;
  perform pos.assert_pin_length(p_pin, p_role);
  insert into public.users (full_name, role, pin_hash)
  values (btrim(p_full_name), p_role, pos.hash_pin(p_pin))
  returning id into v_id;
  return v_id;
end $$;

-- Removes a customer's name and phone number on their request (Data Privacy
-- Act). Their sales and payments stay, as the store's financial records,
-- under "Removed customer". Refused while they still owe money.
--   select pos.anonymize_customer('<the customer''s id, from Table Editor > customers>');
create or replace function pos.anonymize_customer(p_customer uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_owed numeric := pos.customer_owed(p_customer);
begin
  if not exists (select 1 from public.customers c where c.id = p_customer) then
    raise exception 'No customer has that id.';
  end if;
  if v_owed > 0.004 then
    raise exception 'This customer still owes %. Record their payment first.', v_owed;
  end if;
  update public.customers set name = 'Removed customer', phone = null, is_active = false where id = p_customer;
  insert into public.audit_logs (terminal_id, action_type, entity_type, entity_id, details, client_created_at)
  values ('sql-editor', 'customer_anonymized', 'customer', p_customer, '{}'::jsonb, now());
  return 'The customer''s name and phone number were removed.';
end $$;

-- Registers a device and returns its key. The key is shown this once and
-- only its sha256 is kept: type it into the device's "Set up this terminal"
-- box. To retire a device, set is_active to false on its terminals row.
create or replace function pos.add_terminal(p_name text) returns text
language plpgsql set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no 0/O or 1/I/L to mix up
  v_bytes bytea := extensions.gen_random_bytes(24);
  v_key text := '';
begin
  for i in 0 .. 23 loop
    v_key := v_key || substr(v_alphabet, get_byte(v_bytes, i) % length(v_alphabet) + 1, 1);
  end loop;
  insert into public.terminals (name, api_key_hash)
  values (coalesce(nullif(btrim(p_name), ''), 'Terminal'), pos.sha256_hex(v_key));
  return regexp_replace(v_key, '(.{4})(?!$)', '\1-', 'g');
end $$;

-- ===========================================================================
-- The API
-- ===========================================================================

-- Connectivity check (Laravel's /up).
create or replace function public.pos_ping() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', true)
$$;

-- ---------------------------------------------------------------------------
-- Terminal traffic: a device credential, not a person's sign-in
-- ---------------------------------------------------------------------------

-- Everything a terminal keeps offline, changed since its last pull. Users
-- include pin_hash and totp_secret for offline sign-in; never cost_price.
-- voided_sales lists sales voided since, so the terminal that made one stops
-- counting it in its drawer. server_time is a minute early on purpose:
-- something saved while this pull was reading arrives with the next one.
create or replace function public.pos_catalog(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_since timestamptz;
begin
  perform pos.require_terminal(auth);
  v_since := coalesce(pos.arg_time(args, 'since', 'since'), 'epoch'::timestamptz);

  return jsonb_build_object(
    'server_time', now() - interval '1 minute',
    'products', (select coalesce(jsonb_agg(to_jsonb(p) - 'cost_price'), '[]'::jsonb) from public.products p where p.updated_at >= v_since),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.categories c where c.updated_at >= v_since),
    'users', (select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from public.users u where u.updated_at >= v_since),
    'stock_batches', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from public.stock_batches b where b.updated_at >= v_since),
    'customers', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'is_active', c.is_active, 'updated_at', c.updated_at)), '[]'::jsonb)
                  from public.customers c where c.updated_at >= v_since),
    'voided_sales', (select coalesce(jsonb_agg(s.id), '[]'::jsonb) from public.sales s where s.status = 'voided' and s.updated_at >= v_since));
end $$;

-- args: { items: [{ id, entity_type, payload }, ...] }. Answers ok or the
-- error per item, so the terminal clears what went through and retries the
-- rest. Each item stands alone: one bad item never undoes the others.
create or replace function public.pos_sync_push(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_item jsonb;
  v_key text;
  v_results jsonb := '{}'::jsonb;
begin
  perform pos.require_terminal(auth);
  if jsonb_typeof(args -> 'items') is distinct from 'array' then
    perform pos.fail(422, 'The items field is required.');
  end if;

  for v_item in select e.value from jsonb_array_elements(args -> 'items') as e loop
    v_key := coalesce(v_item ->> 'id', '');
    begin
      perform pos.push_one(v_item ->> 'entity_type', v_item -> 'payload');
      v_results := v_results || jsonb_build_object(v_key, jsonb_build_object('ok', true));
    exception when others then
      raise warning 'sync push failed (% %): %', v_item ->> 'entity_type', v_key, sqlerrm;
      v_results := v_results || jsonb_build_object(v_key, jsonb_build_object('ok', false, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('results', v_results);
end $$;

-- args: { user_id, pin }. Swaps a person's password for a server sign-in
-- token, for the screens that read the server. The terminal signs people in
-- offline from its own copy; this is the same password, checked here.
create or replace function public.pos_login(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_pin text := coalesce(args ->> 'pin', '');
  v_user public.users;
  v_problem text;
  v_token text;
begin
  perform pos.require_terminal(auth);
  if v_pin !~ '^(\d{4}|\d{6})$' then
    perform pos.fail(422, 'That password isn''t right — try again.');
  end if;
  select * into v_user from public.users u where u.id = pos.uuid_or_null(args ->> 'user_id') and u.is_active;
  if not found then
    perform pos.fail(422, 'That password isn''t right — try again.');
  end if;

  v_problem := pos.check_pin(v_user.id, v_pin, auth);
  if v_problem is not null then
    perform set_config('response.status', '422', true);
    return jsonb_build_object('message', v_problem);
  end if;

  -- Sign-ins that ran out (see pos.require_user) are cleared as new ones are made.
  delete from public.api_tokens t
  where t.created_at < now() - interval '12 hours' or t.last_used_at < now() - interval '2 hours';

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.api_tokens (user_id, terminal_id, token_hash)
  values (v_user.id, coalesce(nullif(auth ->> 'terminal_id', ''), 'unknown'), pos.sha256_hex(v_token));

  return jsonb_build_object('user', pos.user_json(v_user), 'token', v_token);
end $$;

-- Ends this sign-in. Done at every sign-out, so the next person never
-- inherits it.
create or replace function public.pos_logout(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.api_tokens where token_hash = pos.sha256_hex(coalesce(auth ->> 'token', ''));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard (owners)
-- ---------------------------------------------------------------------------

-- args: { period: today | week | month | year }
create or replace function public.pos_dashboard(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_period text := coalesce(nullif(args ->> 'period', ''), 'today');
  v_tz text := pos.store_timezone();
  v_unit text;
  v_local timestamp;
  v_start timestamptz;
  v_end timestamptz;
  v_sales jsonb;
begin
  perform pos.require_owner(auth);

  -- "Today" is the store's day, not UTC's (which starts at 8 AM in Manila).
  v_unit := case v_period when 'week' then 'week' when 'month' then 'month' when 'year' then 'year' else 'day' end;
  v_local := date_trunc(v_unit, now() at time zone v_tz);
  v_start := v_local at time zone v_tz;
  v_end := (v_local + ('1 ' || v_unit)::interval) at time zone v_tz;

  select jsonb_build_object(
    'total', coalesce(sum(s.total_amount), 0),
    'count', count(*),
    'by_method', coalesce((
      select jsonb_object_agg(m.payment_method, m.total) from (
        select s2.payment_method, sum(s2.total_amount) as total from public.sales s2
        where s2.status = 'completed' and s2.client_created_at >= v_start and s2.client_created_at < v_end
        group by s2.payment_method) m), '{}'::jsonb))
  into v_sales
  from public.sales s
  where s.status = 'completed' and s.client_created_at >= v_start and s.client_created_at < v_end;

  return jsonb_build_object(
    'period', v_period,
    'sales', v_sales,
    'credit_owed', (select coalesce(round(sum(pos.customer_owed(c.id)), 2), 0) from public.customers c),
    -- Current stock, not tied to the period.
    'stock', jsonb_build_object(
      'store_value', (select coalesce(sum(b.qty_good_remaining * p.unit_price), 0)
                      from public.stock_batches b join public.products p on p.id = b.product_id
                      where p.is_active and b.location = 'store'),
      'warehouse_value', (select coalesce(sum(b.qty_good_remaining * p.unit_price), 0)
                          from public.stock_batches b join public.products p on p.id = b.product_id
                          where p.is_active and b.location = 'warehouse'),
      'low_stock_count', (select count(*) from public.products p
                          where p.is_active
                            and coalesce((select sum(b.qty_good_remaining) from public.stock_batches b
                                          where b.product_id = p.id), 0) <= p.reorder_level)),
    'on_shift', (select coalesce(jsonb_agg(jsonb_build_object('name', u.full_name, 'started_at', sh.started_at) order by sh.started_at desc), '[]'::jsonb)
                 from public.shift_logs sh left join public.users u on u.id = sh.cashier_id
                 where sh.status = 'open'),
    -- Voided sales don't count as sold.
    'top_selling', (select coalesce(jsonb_agg(to_jsonb(t) order by t.units_sold desc, t.name), '[]'::jsonb) from (
                      select p.id, p.name, p.unit, sum(abs(m.delta)) as units_sold
                      from public.stock_movements m join public.products p on p.id = m.product_id
                      where m.reason = 'sale' and m.client_created_at >= v_start and m.client_created_at < v_end
                        and not exists (select 1 from public.sales s where s.id = m.reference_id and s.status = 'voided')
                      group by p.id, p.name, p.unit
                      order by units_sold desc, p.name
                      limit 5) t),
    -- In stock but unsold for 30 days, most money tied up first.
    'not_selling', (select coalesce(jsonb_agg(to_jsonb(t) order by t.value desc), '[]'::jsonb) from (
                      select p.id, p.name, p.unit, sum(b.qty_good_remaining) as units,
                             sum(b.qty_good_remaining) * p.unit_price as value
                      from public.stock_batches b join public.products p on p.id = b.product_id
                      where p.is_active
                        and not exists (select 1 from public.stock_movements m
                                        where m.product_id = p.id and m.reason = 'sale'
                                          and m.client_created_at >= now() - interval '30 days'
                                          and not exists (select 1 from public.sales s where s.id = m.reference_id and s.status = 'voided'))
                      group by p.id, p.name, p.unit, p.unit_price
                      having sum(b.qty_good_remaining) > 0
                      order by sum(b.qty_good_remaining) * p.unit_price desc
                      limit 5) t));
end $$;

-- ---------------------------------------------------------------------------
-- Items and stock (owners). cost_price never leaves the server.
-- ---------------------------------------------------------------------------

-- args: { include_archived }. Each item's good stock in the store and the
-- warehouse, plus damaged units. A batch two offline tills both sold from
-- goes below zero; it counts too, so the screen shows what's really on hand
-- (and what a count correction is measured against).
create or replace function public.pos_stock(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_archived boolean;
begin
  perform pos.require_owner(auth);
  v_archived := coalesce(pos.arg_bool(args, 'include_archived', 'include_archived'), false);

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'sku', r.sku, 'name', r.name, 'category_id', r.category_id, 'unit', r.unit,
        'unit_price', r.unit_price, 'reorder_level', r.reorder_level, 'is_active', r.is_active,
        'store_good', r.store_good, 'warehouse_good', r.warehouse_good, 'damaged', r.damaged,
        'low_stock', r.store_good + r.warehouse_good <= r.reorder_level) order by r.name), '[]'::jsonb)
    from (
      select p.id, p.sku, p.name, p.category_id, p.unit, p.unit_price, p.reorder_level, p.is_active,
             coalesce(sum(b.qty_good_remaining) filter (where b.location = 'store'), 0) as store_good,
             coalesce(sum(b.qty_good_remaining) filter (where b.location = 'warehouse'), 0) as warehouse_good,
             coalesce(sum(b.qty_damaged), 0) as damaged
      from public.products p
      left join public.stock_batches b on b.product_id = p.id and (b.qty_good_remaining <> 0 or b.qty_damaged > 0)
      where v_archived or p.is_active
      group by p.id) r);
end $$;

create or replace function public.pos_categories(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
begin
  perform pos.require_owner(auth);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name), '[]'::jsonb)
          from public.categories c where c.is_active);
end $$;

-- args: { category_id }. Suggests the next item code from the codes already
-- used in that category ("CEM-004" suggests "CEM-005"), or builds a short
-- code from the category's name when it has no items yet. Only a
-- suggestion: the field on screen can be typed over.
create or replace function public.pos_next_sku(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_category uuid;
  v_prefix text;
  v_next numeric;
begin
  perform pos.require_owner(auth);
  v_category := pos.arg_uuid(args, 'category_id', 'Category');
  if v_category is null or not exists (select 1 from public.categories c where c.id = v_category) then
    perform pos.fail(422, 'Choose a category.');
  end if;

  select upper(split_part(p.sku, '-', 1)) into v_prefix
  from public.products p where p.category_id = v_category
  group by 1
  order by count(*) desc, min(p.created_at), 1
  limit 1;

  if v_prefix is null or v_prefix in ('', '0') then
    select left(coalesce(string_agg(upper(left(w.word, 1)), '' order by w.n), ''), 4) into v_prefix
    from public.categories c, regexp_split_to_table(c.name, '[\s&,]+') with ordinality as w(word, n)
    where c.id = v_category and w.word not in ('', '0');
    v_prefix := coalesce(nullif(v_prefix, ''), 'ITM');
  end if;

  select greatest(1, coalesce(max(substring(p.sku from '-(\d+)$')::numeric) + 1, 1)) into v_next
  from public.products p
  where p.category_id = v_category and starts_with(upper(p.sku), v_prefix || '-') and p.sku ~ '-\d+$';

  return jsonb_build_object('sku', v_prefix || '-' || lpad(v_next::text, greatest(3, length(v_next::text)), '0'));
end $$;

-- args: { sku, name, category_id, unit, unit_price, reorder_level,
-- store_qty, warehouse_qty }. A new item, with its starting counts. The
-- barcode is an internal 12-digit code starting with "200", a block real
-- manufacturer barcodes don't use, so it never collides with a printed one.
create or replace function public.pos_product_create(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
  v_sku text := btrim(coalesce(args ->> 'sku', ''));
  v_name text := btrim(coalesce(args ->> 'name', ''));
  v_unit text := btrim(coalesce(args ->> 'unit', ''));
  v_category uuid;
  v_price numeric;
  v_reorder numeric;
  v_store numeric;
  v_warehouse numeric;
  v_barcode text;
  v_product public.products;
begin
  v_user := pos.require_owner(auth);
  v_category := pos.arg_uuid(args, 'category_id', 'Category');
  v_price := pos.arg_number(args, 'unit_price', 'The price', 0);
  v_reorder := pos.arg_number(args, 'reorder_level', 'The low stock level', 0);
  v_store := pos.arg_number(args, 'store_qty', 'The store count', 0);
  v_warehouse := pos.arg_number(args, 'warehouse_qty', 'The warehouse count', 0);

  if v_sku = '' or length(v_sku) > 100 then
    perform pos.fail(422, 'Enter an item code (up to 100 characters).');
  end if;
  if exists (select 1 from public.products p where p.sku = v_sku) then
    perform pos.fail(422, 'The item code ' || v_sku || ' is already used by another item.');
  end if;
  if v_name = '' or length(v_name) > 255 then
    perform pos.fail(422, 'Enter the item''s name (up to 255 characters).');
  end if;
  if v_category is null or not exists (select 1 from public.categories c where c.id = v_category) then
    perform pos.fail(422, 'Choose a category.');
  end if;
  if v_unit = '' or length(v_unit) > 20 then
    perform pos.fail(422, 'Choose the unit it''s sold by.');
  end if;
  if v_price is null then
    perform pos.fail(422, 'Enter the price.');
  end if;

  loop
    v_barcode := '200' || lpad(floor(random() * 1000000000)::bigint::text, 9, '0');
    exit when not exists (select 1 from public.products p where p.barcode = v_barcode);
  end loop;

  insert into public.products (sku, barcode, name, category_id, unit, unit_price, cost_price, reorder_level, is_active)
  values (v_sku, v_barcode, v_name, v_category, v_unit, v_price, null, coalesce(v_reorder, 10), true)
  returning * into v_product;

  if coalesce(v_store, 0) > 0 then
    perform pos.set_stock(v_product.id, 'store', v_store, v_user.id, 'Starting stock', 'stock_receipt');
  end if;
  if coalesce(v_warehouse, 0) > 0 then
    perform pos.set_stock(v_product.id, 'warehouse', v_warehouse, v_user.id, 'Starting stock', 'stock_receipt');
  end if;

  perform pos.record_activity(auth, v_user.id, 'item_added_to_catalog', 'product', v_product.id,
    jsonb_build_object('product_name', v_product.name, 'sku', v_product.sku));

  return to_jsonb(v_product);
end $$;

-- args: { id, name?, unit?, unit_price?, reorder_level?, is_active?,
-- store_qty?, warehouse_qty? }. The everyday edits from the Stock screen:
-- details, archive / restore, and the store / warehouse counts. Only the
-- counts that were sent are set, so a sale made meanwhile isn't overwritten.
create or replace function public.pos_product_update(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
  v_id uuid;
  v_before public.products;
  v_after public.products;
  v_name text;
  v_unit text;
  v_price numeric;
  v_reorder numeric;
  v_active boolean;
  v_store numeric;
  v_warehouse numeric;
  v_delta numeric;
  v_changed text[] := '{}';
begin
  v_user := pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'Item');
  select * into v_before from public.products p where p.id = v_id for update;
  if not found then
    perform pos.fail(404, 'That item no longer exists.');
  end if;

  if args ? 'name' then
    v_name := btrim(coalesce(args ->> 'name', ''));
    if v_name = '' or length(v_name) > 255 then
      perform pos.fail(422, 'Enter the item''s name (up to 255 characters).');
    end if;
  end if;
  if args ? 'unit' then
    v_unit := btrim(coalesce(args ->> 'unit', ''));
    if v_unit = '' or length(v_unit) > 20 then
      perform pos.fail(422, 'Choose the unit it''s sold by.');
    end if;
  end if;
  v_price := pos.arg_number(args, 'unit_price', 'The price', 0);
  v_reorder := pos.arg_number(args, 'reorder_level', 'The low stock level', 0);
  v_active := pos.arg_bool(args, 'is_active', 'is_active');
  v_store := pos.arg_number(args, 'store_qty', 'The store count', 0);
  v_warehouse := pos.arg_number(args, 'warehouse_qty', 'The warehouse count', 0);

  update public.products p set
    name = coalesce(v_name, p.name),
    unit = coalesce(v_unit, p.unit),
    unit_price = coalesce(v_price, p.unit_price),
    reorder_level = coalesce(v_reorder, p.reorder_level),
    is_active = coalesce(v_active, p.is_active)
  where p.id = v_before.id
  returning * into v_after;

  if v_store is not null then
    v_delta := pos.set_stock(v_after.id, 'store', v_store, v_user.id, 'Count corrected on the Stock screen');
    if abs(v_delta) >= 0.001 then
      perform pos.record_activity(auth, v_user.id, 'stock_quantity_adjusted', 'product', v_after.id,
        jsonb_build_object('product_name', v_after.name, 'location', 'store', 'delta', v_delta));
    end if;
  end if;
  if v_warehouse is not null then
    v_delta := pos.set_stock(v_after.id, 'warehouse', v_warehouse, v_user.id, 'Count corrected on the Stock screen');
    if abs(v_delta) >= 0.001 then
      perform pos.record_activity(auth, v_user.id, 'stock_quantity_adjusted', 'product', v_after.id,
        jsonb_build_object('product_name', v_after.name, 'location', 'warehouse', 'delta', v_delta));
    end if;
  end if;

  if v_price is not null and v_price <> v_before.unit_price then
    perform pos.record_activity(auth, v_user.id, 'price_changed', 'product', v_after.id,
      jsonb_build_object('product_name', v_after.name, 'from', v_before.unit_price, 'to', v_price));
  end if;

  if v_active is not null and v_active <> v_before.is_active then
    perform pos.record_activity(auth, v_user.id, case when v_active then 'item_restored' else 'item_archived' end,
      'product', v_after.id, jsonb_build_object('product_name', v_after.name));
  end if;

  if v_name is not null and v_name <> v_before.name then
    v_changed := array_append(v_changed, 'name');
  end if;
  if v_unit is not null and v_unit <> v_before.unit then
    v_changed := array_append(v_changed, 'unit');
  end if;
  if v_reorder is not null and v_reorder <> v_before.reorder_level then
    v_changed := array_append(v_changed, 'reorder_level');
  end if;
  if cardinality(v_changed) > 0 then
    perform pos.record_activity(auth, v_user.id, 'item_details_updated', 'product', v_after.id,
      jsonb_build_object('product_name', v_after.name, 'changed_fields', to_jsonb(v_changed)));
  end if;

  return jsonb_build_object('id', v_after.id, 'sku', v_after.sku, 'name', v_after.name, 'unit', v_after.unit,
    'unit_price', v_after.unit_price, 'reorder_level', v_after.reorder_level, 'is_active', v_after.is_active);
end $$;

-- ---------------------------------------------------------------------------
-- Pick lists (everyone). They're created offline and arrive through sync;
-- here they're read and marked picked up.
-- ---------------------------------------------------------------------------

-- args: { status?, page? }. Newest first, with the sale (its Ref no. is on
-- the customer's slip) and the credit customer.
create or replace function public.pos_material_requests(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_status text := nullif(args ->> 'status', '');
  v_page integer;
  v_total bigint;
  v_rows jsonb;
begin
  perform pos.require_user(auth);
  v_page := greatest(1, coalesce(pos.arg_number(args, 'page', 'page')::integer, 1));

  select count(*) into v_total from public.material_requests r where v_status is null or r.status = v_status;
  select jsonb_agg(pos.material_request_json(x.r) order by (x.r).client_created_at desc) into v_rows
  from (select r from public.material_requests r
        where v_status is null or r.status = v_status
        order by r.client_created_at desc
        limit 50 offset (v_page - 1) * 50) x;

  return pos.page_json(v_rows, v_total, v_page, 50);
end $$;

-- args: { id }. The items were handed over.
create or replace function public.pos_material_request_fulfill(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
  v_id uuid;
  v_request public.material_requests;
begin
  v_user := pos.require_user(auth);
  v_id := pos.arg_uuid(args, 'id', 'Pick list');
  select * into v_request from public.material_requests r where r.id = v_id for update;
  if not found then
    perform pos.fail(404, 'That pick list no longer exists.');
  end if;
  if v_request.status = 'cancelled'
     or exists (select 1 from public.sales s where s.id = v_request.sale_id and s.status = 'voided') then
    perform pos.fail(422, 'This sale was voided. Don''t hand these items over.');
  end if;
  if v_request.status <> 'pending' then
    perform pos.fail(422, 'This list was already picked up.');
  end if;

  update public.material_requests
  set status = 'fulfilled', fulfilled_by = v_user.id, fulfilled_at = now()
  where id = v_request.id
  returning * into v_request;

  perform pos.record_activity(auth, v_user.id, 'pick_list_done', 'material_request', v_request.id, jsonb_strip_nulls(jsonb_build_object(
    'item_count', jsonb_array_length(case when jsonb_typeof(v_request.items) = 'array' then v_request.items else '[]'::jsonb end),
    'sale_ref', upper(left(v_request.sale_id::text, 8)))));

  return to_jsonb(v_request);
end $$;

-- ---------------------------------------------------------------------------
-- Sales, shifts, returns (owners)
-- ---------------------------------------------------------------------------

-- args: { from?, to?, status?, shift_id?, page? }. Newest first, with the
-- items, the cashier, the credit customer, and a void waiting for approval,
-- plus totals: completed sales per payment method over the whole range.
create or replace function public.pos_sales(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_shift uuid;
  v_status text := nullif(args ->> 'status', '');
  v_from timestamptz;
  v_to timestamptz;
  v_page integer;
  v_total bigint;
  v_rows jsonb;
  v_totals jsonb;
begin
  perform pos.require_owner(auth);
  v_shift := pos.arg_uuid(args, 'shift_id', 'Shift');
  v_from := pos.arg_time(args, 'from', 'From');
  v_to := pos.arg_time(args, 'to', 'To');
  v_page := greatest(1, coalesce(pos.arg_number(args, 'page', 'page')::integer, 1));

  with found as (
    select s from public.sales s
    where (v_shift is null or s.shift_id = v_shift)
      and (v_status is null or s.status = v_status)
      and (v_from is null or s.client_created_at >= v_from)
      and (v_to is null or s.client_created_at <= v_to)
  ), page as (
    select f.s from found f
    order by (f.s).client_created_at desc
    limit 100 offset (v_page - 1) * 100
  )
  select
    (select count(*) from found),
    (select coalesce(jsonb_object_agg(t.payment_method, t.total), '{}'::jsonb)
     from (select (f.s).payment_method as payment_method, sum((f.s).total_amount) as total
           from found f where (f.s).status = 'completed'
           group by 1) t),
    (select jsonb_agg(pos.sale_json(x.s) || jsonb_build_object('pending_void', (
              select jsonb_build_object('id', v.id, 'sale_id', v.sale_id, 'expires_at', v.expires_at)
              from public.void_requests v
              where v.sale_id = (x.s).id and v.status = 'pending' and v.expires_at > now()
              limit 1))
            order by (x.s).client_created_at desc)
     from page x)
  into v_total, v_totals, v_rows;

  return pos.page_json(v_rows, v_total, v_page, 100) || jsonb_build_object('totals', v_totals);
end $$;

-- args: { cashier_id?, page? }. Newest first, with what each one sold.
create or replace function public.pos_shifts(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_cashier uuid;
  v_page integer;
  v_total bigint;
  v_rows jsonb;
begin
  perform pos.require_owner(auth);
  v_cashier := pos.arg_uuid(args, 'cashier_id', 'Staff');
  v_page := greatest(1, coalesce(pos.arg_number(args, 'page', 'page')::integer, 1));

  select count(*) into v_total from public.shift_logs sh where v_cashier is null or sh.cashier_id = v_cashier;

  select jsonb_agg(to_jsonb(x.sh) || jsonb_build_object(
           'cashier', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'role', u.role)
                       from public.users u where u.id = (x.sh).cashier_id),
           'sales_count', (select count(*) from public.sales s where s.shift_id = (x.sh).id and s.status = 'completed'),
           'sales_total', (select sum(s.total_amount) from public.sales s where s.shift_id = (x.sh).id and s.status = 'completed'))
         order by (x.sh).started_at desc) into v_rows
  from (select sh from public.shift_logs sh
        where v_cashier is null or sh.cashier_id = v_cashier
        order by sh.started_at desc
        limit 50 offset (v_page - 1) * 50) x;

  return pos.page_json(v_rows, v_total, v_page, 50);
end $$;

-- args: { id }. The shift and everything that happened during it, for its
-- timeline: sales, credit payments taken, and every logged action.
create or replace function public.pos_shift(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_id uuid;
  v_shift public.shift_logs;
begin
  perform pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'Shift');
  select * into v_shift from public.shift_logs sh where sh.id = v_id;
  if not found then
    perform pos.fail(404, 'That shift isn''t on the server yet.');
  end if;

  return jsonb_build_object(
    'shift', to_jsonb(v_shift) || jsonb_build_object('cashier', (
      select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'role', u.role) from public.users u where u.id = v_shift.cashier_id)),
    'sales', (select coalesce(jsonb_agg(pos.sale_json(s) order by s.client_created_at), '[]'::jsonb)
              from public.sales s where s.shift_id = v_shift.id),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('customer', (
                   select jsonb_build_object('id', c.id, 'name', c.name) from public.customers c where c.id = p.customer_id))
                 order by p.client_created_at), '[]'::jsonb)
                 from public.credit_payments p where p.shift_id = v_shift.id),
    'activity', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', a.id, 'event_type', a.event_type, 'entity_type', a.entity_type, 'entity_id', a.entity_id,
                   'details', a.details, 'ip_address', a.ip_address, 'client_created_at', a.client_created_at)
                 order by a.client_created_at), '[]'::jsonb)
                 from (select * from public.activity_log a where a.shift_id = v_shift.id
                       order by a.client_created_at limit 3000) a));
end $$;

-- args: { id, product_id, quantity_returned, condition, reason,
-- client_created_at, original_sale_item_id? }. A good return goes back on
-- sale at the back of the FIFO queue; a damaged one is kept apart, never
-- offered for sale. A reason (or slip number) is required as proof.
create or replace function public.pos_return_create(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
  v_id uuid;
  v_item uuid;
  v_product_id uuid;
  v_product public.products;
  v_quantity numeric;
  v_condition text := args ->> 'condition';
  v_reason text := btrim(coalesce(args ->> 'reason', ''));
  v_when timestamptz;
  v_return public.sales_returns;
begin
  v_user := pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'The return');
  v_item := pos.arg_uuid(args, 'original_sale_item_id', 'The sale line');
  v_product_id := pos.arg_uuid(args, 'product_id', 'The item');
  v_quantity := pos.arg_number(args, 'quantity_returned', 'The quantity returned', 0.001);
  v_when := pos.arg_time(args, 'client_created_at', 'The time');

  if v_id is null then
    perform pos.fail(422, 'The return needs an id.');
  end if;
  select * into v_return from public.sales_returns r where r.id = v_id;
  if found then
    return to_jsonb(v_return); -- sent twice: it was already accepted
  end if;

  select * into v_product from public.products p where p.id = v_product_id;
  if not found then
    perform pos.fail(422, 'Pick the item being returned.');
  end if;
  if v_item is not null and not exists (select 1 from public.sale_items i where i.id = v_item) then
    perform pos.fail(422, 'That sale line doesn''t exist.');
  end if;
  if v_quantity is null then
    perform pos.fail(422, 'Enter the quantity returned.');
  end if;
  if v_condition is null or v_condition not in ('good', 'damaged') then
    perform pos.fail(422, 'Say whether the item is good or damaged.');
  end if;
  if length(v_reason) < 3 or length(v_reason) > 255 then
    perform pos.fail(422, 'Write the invoice or slip number, or the reason. It is the proof for this return.');
  end if;
  v_when := coalesce(v_when, now());

  insert into public.sales_returns (id, original_sale_item_id, product_id, quantity_returned, condition, processed_by, reason, client_created_at)
  values (v_id, v_item, v_product.id, v_quantity, v_condition, v_user.id, v_reason, v_when)
  returning * into v_return;

  insert into public.stock_batches (product_id, location, received_at, qty_received, qty_good_remaining, qty_damaged,
    source, reference_id, created_by, client_created_at)
  values (v_product.id, 'store', now(), v_quantity,
          case when v_condition = 'good' then v_quantity else 0 end,
          case when v_condition = 'damaged' then v_quantity else 0 end,
          'return_accepted', v_return.id, v_user.id, v_when);

  insert into public.audit_logs (terminal_id, actor_id, approver_id, action_type, entity_type, entity_id, details, client_created_at)
  values (coalesce(nullif(auth ->> 'terminal_id', ''), 'unknown'), v_user.id, v_user.id, 'return_accepted', 'sales_return', v_return.id,
          jsonb_strip_nulls(jsonb_build_object(
            'id', v_return.id, 'original_sale_item_id', v_item, 'product_id', v_product.id, 'quantity_returned', v_quantity,
            'condition', v_condition, 'reason', v_reason, 'client_created_at', v_when, 'processed_by', v_user.id)),
          v_when);

  perform pos.record_activity(auth, v_user.id, 'return_accepted', 'sales_return', v_return.id,
    jsonb_build_object('product_name', v_product.name, 'quantity', v_quantity, 'condition', v_condition));

  return to_jsonb(v_return);
end $$;

-- ---------------------------------------------------------------------------
-- Voids (owners). One owner asks, which counts as their yes; a second owner
-- approves from their own device, or at the same screen with their own
-- password. Ten minutes without that and the request lapses. Any owner can
-- say no, which ends it at once.
-- ---------------------------------------------------------------------------

-- The ones still waiting, oldest first.
create or replace function public.pos_void_requests(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
begin
  perform pos.require_owner(auth);
  perform pos.expire_overdue_voids();
  return (select coalesce(jsonb_agg(pos.present_void(v.id) order by v.created_at), '[]'::jsonb)
          from public.void_requests v where v.status = 'pending');
end $$;

-- args: { id }. One request, so the screen that asked can follow it.
create or replace function public.pos_void_request(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_id uuid;
begin
  perform pos.require_owner(auth);
  perform pos.expire_overdue_voids();
  v_id := pos.arg_uuid(args, 'id', 'Void request');
  if v_id is null or not exists (select 1 from public.void_requests v where v.id = v_id) then
    perform pos.fail(404, 'That void request no longer exists.');
  end if;
  return pos.present_void(v_id);
end $$;

-- args: { sale_id, reason }
create or replace function public.pos_void_request_create(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
  v_reason text := btrim(coalesce(args ->> 'reason', ''));
  v_sale_id uuid;
  v_sale public.sales;
  v_id uuid;
begin
  v_user := pos.require_owner(auth);
  if v_reason = '' then
    perform pos.fail(422, 'Enter a reason for the record.');
  end if;
  if length(v_reason) > 255 then
    perform pos.fail(422, 'Keep the reason under 255 characters.');
  end if;
  v_sale_id := pos.arg_uuid(args, 'sale_id', 'Sale');
  select * into v_sale from public.sales s where s.id = v_sale_id;
  if not found then
    perform pos.fail(404, 'That sale isn''t on the server yet.');
  end if;
  if v_sale.status <> 'completed' then
    perform pos.fail(422, 'Only a completed sale can be voided.');
  end if;
  if (select count(*) from public.users u where u.role = 'owner' and u.is_active) < 2 then
    perform pos.fail(422, 'A void needs two owners to approve it, and this store has only one owner account. Add the other owner in Staff first.');
  end if;

  perform pos.expire_overdue_voids();
  if exists (select 1 from public.void_requests v where v.sale_id = v_sale.id and v.status = 'pending') then
    perform pos.fail(422, 'This sale already has a void waiting for approval.');
  end if;

  begin
    insert into public.void_requests (sale_id, requested_by, reason, status, expires_at)
    values (v_sale.id, v_user.id, v_reason, 'pending', now() + interval '10 minutes')
    returning id into v_id;
  exception when unique_violation then
    perform pos.fail(422, 'This sale already has a void waiting for approval.'); -- two owners asked at the same moment
  end;
  insert into public.void_request_approvals (void_request_id, user_id) values (v_id, v_user.id);

  perform pos.record_activity(auth, v_user.id, 'void_requested', 'sale', v_sale.id,
    jsonb_build_object('total_amount', v_sale.total_amount::text, 'reason', v_reason));

  return pos.present_void(v_id);
end $$;

-- args: { id }. The signed-in owner says yes.
create or replace function public.pos_void_approve(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
begin
  v_user := pos.require_owner(auth);
  return pos.approve_void_as(auth, pos.arg_uuid(args, 'id', 'Void request'), v_user);
end $$;

-- args: { id, user_id, pin, code? }. Another owner says yes at this screen
-- with their own password, plus their authenticator code if they use one.
-- Whoever is signed in here only provides the connection.
create or replace function public.pos_void_approve_here(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner public.users;
  v_problem text;
begin
  perform pos.require_user(auth);
  select * into v_owner from public.users u
  where u.id = pos.uuid_or_null(args ->> 'user_id') and u.role = 'owner' and u.is_active;
  if not found then
    perform pos.fail(422, 'Choose an owner.');
  end if;

  v_problem := pos.check_pin(v_owner.id, coalesce(args ->> 'pin', ''), auth);
  if v_problem is not null then
    perform set_config('response.status', '422', true);
    return jsonb_build_object('message', v_problem);
  end if;

  if v_owner.totp_enabled and not pos.totp_verify(v_owner.totp_secret, args ->> 'code') then
    insert into public.audit_logs (terminal_id, action_type, entity_type, entity_id, details, client_created_at)
    values (coalesce(nullif(auth ->> 'terminal_id', ''), 'unknown'), 'failed_pin_attempt', 'user', v_owner.id,
            jsonb_build_object('step', 'code', 'checked', 'server'), now());
    perform set_config('response.status', '422', true);
    return jsonb_build_object('message', 'That authenticator code is wrong or has expired.');
  end if;

  return pos.approve_void_as(auth, pos.arg_uuid(args, 'id', 'Void request'), v_owner);
end $$;

-- args: { id }. An owner says no. From the owner who asked, it withdraws
-- the request instead.
create or replace function public.pos_void_reject(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user public.users;
  v_request public.void_requests;
begin
  v_user := pos.require_owner(auth);
  perform pos.expire_overdue_voids();
  v_request := pos.lock_open_void(pos.arg_uuid(args, 'id', 'Void request'));

  update public.void_requests
  set status = case when v_request.requested_by = v_user.id then 'cancelled' else 'rejected' end,
      resolved_by = v_user.id,
      resolved_at = now()
  where id = v_request.id
  returning * into v_request;

  perform pos.record_activity(auth, v_user.id, case when v_request.status = 'cancelled' then 'void_cancelled' else 'void_rejected' end,
    'sale', v_request.sale_id, (
      select jsonb_build_object('total_amount', s.total_amount::text, 'reason', v_request.reason)
      from public.sales s where s.id = v_request.sale_id));

  return pos.present_void(v_request.id);
end $$;

-- ---------------------------------------------------------------------------
-- Credit ("utang"), for everyone: a cashier is the one who takes a
-- customer's payment at the counter. Customers and payments are made at the
-- register and arrive through sync; these only read balances and history.
-- ---------------------------------------------------------------------------

-- args: { q? }. Everyone with a credit history, biggest balance first.
create or replace function public.pos_customers(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_q text := nullif(btrim(coalesce(args ->> 'q', '')), '');
  v_rows jsonb;
  v_total numeric;
begin
  perform pos.require_user(auth);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'phone', c.phone, 'owed', c.owed, 'last_activity_at', c.last_activity_at)
         order by c.owed desc, c.name), '[]'::jsonb),
         coalesce(round(sum(c.owed), 2), 0)
  into v_rows, v_total
  from (
    select c.id, c.name, c.phone, pos.customer_owed(c.id) as owed,
           (select max(s.client_created_at) from public.sales s where s.customer_id = c.id) as last_activity_at
    from public.customers c
    where c.is_active
      and (v_q is null or c.name ilike '%' || v_q || '%' or c.phone ilike '%' || v_q || '%')) c;

  return jsonb_build_object('customers', v_rows, 'total_owed', v_total);
end $$;

-- args: { id }. The balance and everything behind it.
create or replace function public.pos_customer(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_id uuid;
  v_customer public.customers;
begin
  perform pos.require_user(auth);
  v_id := pos.arg_uuid(args, 'id', 'Customer');
  select * into v_customer from public.customers c where c.id = v_id;
  if not found then
    perform pos.fail(404, 'That customer isn''t on the server yet.');
  end if;

  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_customer.id, 'name', v_customer.name, 'phone', v_customer.phone,
                                   'owed', pos.customer_owed(v_customer.id)),
    'sales', (select coalesce(jsonb_agg(pos.sale_json(s) order by s.client_created_at desc), '[]'::jsonb)
              from public.sales s where s.customer_id = v_customer.id),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('received_by', pos.user_brief(p.received_by))
                   order by p.client_created_at desc), '[]'::jsonb)
                 from public.credit_payments p where p.customer_id = v_customer.id));
end $$;

-- ---------------------------------------------------------------------------
-- Staff (owners). Deactivated accounts can't sign in but are never deleted,
-- so their history stays.
-- ---------------------------------------------------------------------------

-- args: { include_archived }
create or replace function public.pos_users(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_archived boolean;
begin
  perform pos.require_owner(auth);
  v_archived := coalesce(pos.arg_bool(args, 'include_archived', 'include_archived'), false);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', u.id, 'full_name', u.full_name, 'role', u.role, 'is_active', u.is_active, 'totp_enabled', u.totp_enabled)
          order by u.full_name), '[]'::jsonb)
          from public.users u where v_archived or u.is_active);
end $$;

-- args: { full_name, role, pin }
create or replace function public.pos_user_create(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner public.users;
  v_name text := btrim(coalesce(args ->> 'full_name', ''));
  v_role text := args ->> 'role';
  v_pin text := coalesce(args ->> 'pin', '');
  v_user public.users;
begin
  v_owner := pos.require_owner(auth);
  if v_name = '' or length(v_name) > 255 then
    perform pos.fail(422, 'Enter the person''s name (up to 255 characters).');
  end if;
  if v_role is null or v_role not in ('cashier', 'owner') then
    perform pos.fail(422, 'Choose cashier or owner.');
  end if;
  if v_pin !~ '^[0-9]+$' then
    perform pos.fail(422, 'The password can only have digits.');
  end if;
  perform pos.assert_pin_length(v_pin, v_role);

  insert into public.users (full_name, role, pin_hash, is_active)
  values (v_name, v_role, pos.hash_pin(v_pin), true)
  returning * into v_user;

  perform pos.record_activity(auth, v_owner.id, 'staff_added', 'user', v_user.id,
    jsonb_build_object('staff_name', v_user.full_name, 'role', v_user.role));

  return pos.user_json(v_user);
end $$;

-- args: { id, full_name?, role?, pin?, is_active? }. Every change lands in
-- the activity log (the password itself never does, only that it changed).
-- The last active owner can't stop being one: nobody would be left to undo it.
create or replace function public.pos_user_update(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner public.users;
  v_id uuid;
  v_user public.users;
  v_name text;
  v_role text;
  v_pin text;
  v_active boolean;
begin
  v_owner := pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'Staff account');
  select * into v_user from public.users u where u.id = v_id for update;
  if not found then
    perform pos.fail(404, 'That staff account no longer exists.');
  end if;

  if args ? 'full_name' then
    v_name := btrim(coalesce(args ->> 'full_name', ''));
    if v_name = '' or length(v_name) > 255 then
      perform pos.fail(422, 'Enter the person''s name (up to 255 characters).');
    end if;
  end if;
  if args ? 'role' then
    v_role := args ->> 'role';
    if v_role is null or v_role not in ('cashier', 'owner') then
      perform pos.fail(422, 'Choose cashier or owner.');
    end if;
  end if;
  if args ? 'pin' then
    v_pin := coalesce(args ->> 'pin', '');
    if v_pin !~ '^[0-9]+$' then
      perform pos.fail(422, 'The password can only have digits.');
    end if;
  end if;
  v_active := pos.arg_bool(args, 'is_active', 'is_active');

  if v_user.role = 'owner' and v_user.is_active
     and ((v_role is not null and v_role <> 'owner') or v_active = false)
     and (select count(*) from public.users u where u.role = 'owner' and u.is_active) <= 1 then
    perform pos.fail(422, 'This is the only owner account, so it has to stay an active owner. Add another owner first.');
  end if;
  if v_pin is not null then
    perform pos.assert_pin_length(v_pin, coalesce(v_role, v_user.role));
  end if;

  update public.users u set
    full_name = coalesce(v_name, u.full_name),
    role = coalesce(v_role, u.role),
    pin_hash = case when v_pin is not null then pos.hash_pin(v_pin) else u.pin_hash end,
    is_active = coalesce(v_active, u.is_active)
  where u.id = v_user.id
  returning * into v_user;

  if v_active is not null then
    if not v_active then
      delete from public.api_tokens t where t.user_id = v_user.id; -- signed out everywhere
    end if;
    perform pos.record_activity(auth, v_owner.id, case when v_active then 'staff_reactivated' else 'staff_deactivated' end,
      'user', v_user.id, jsonb_build_object('staff_name', v_user.full_name));
  elsif v_name is not null or v_role is not null or v_pin is not null then
    perform pos.record_activity(auth, v_owner.id, 'staff_updated', 'user', v_user.id, jsonb_strip_nulls(jsonb_build_object(
      'staff_name', v_user.full_name, 'role', v_role, 'pin_reset', case when v_pin is not null then true end)));
  end if;

  return pos.user_json(v_user);
end $$;

-- args: { id }. Starts two-factor setup for an owner: a new secret, for the
-- authenticator app (as a QR code or typed in). It isn't on until a code
-- from the app is confirmed with pos_two_factor_verify; starting over just
-- replaces the secret.
create or replace function public.pos_two_factor_setup(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_id uuid;
  v_user public.users;
  v_secret text;
begin
  perform pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'Staff account');
  select * into v_user from public.users u where u.id = v_id;
  if not found then
    perform pos.fail(404, 'That staff account no longer exists.');
  end if;
  if v_user.role <> 'owner' then
    perform pos.fail(422, 'Two-factor login is only available for owner accounts.');
  end if;

  v_secret := pos.base32_encode(extensions.gen_random_bytes(20));
  update public.users set totp_secret = v_secret, totp_enabled = false where id = v_user.id;

  return jsonb_build_object(
    'secret', v_secret,
    'otpauth_url', 'otpauth://totp/' || pos.url_encode('RRC Merchandise:' || v_user.full_name)
      || '?secret=' || v_secret || '&issuer=' || pos.url_encode('RRC Merchandise')
      || '&algorithm=SHA1&digits=6&period=30');
end $$;

-- args: { id, code }. Confirms the app was set up right, then turns
-- two-factor login on.
create or replace function public.pos_two_factor_verify(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner public.users;
  v_id uuid;
  v_user public.users;
begin
  v_owner := pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'Staff account');
  select * into v_user from public.users u where u.id = v_id;
  if not found then
    perform pos.fail(404, 'That staff account no longer exists.');
  end if;
  if v_user.totp_secret is null or not pos.totp_verify(v_user.totp_secret, args ->> 'code') then
    perform pos.fail(422, 'That code did not match. Try again.');
  end if;

  update public.users set totp_enabled = true where id = v_user.id;
  perform pos.record_activity(auth, v_owner.id, 'two_factor_enabled', 'user', v_user.id,
    jsonb_build_object('staff_name', v_user.full_name));

  return jsonb_build_object('enabled', true);
end $$;

-- args: { id }
create or replace function public.pos_two_factor_disable(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner public.users;
  v_id uuid;
  v_user public.users;
begin
  v_owner := pos.require_owner(auth);
  v_id := pos.arg_uuid(args, 'id', 'Staff account');
  select * into v_user from public.users u where u.id = v_id;
  if not found then
    perform pos.fail(404, 'That staff account no longer exists.');
  end if;

  update public.users set totp_secret = null, totp_enabled = false where id = v_user.id;
  perform pos.record_activity(auth, v_owner.id, 'two_factor_disabled', 'user', v_user.id,
    jsonb_build_object('staff_name', v_user.full_name));

  return jsonb_build_object('enabled', false);
end $$;

-- ---------------------------------------------------------------------------
-- Audit log (owners): events that need an owner's eyes. Wrong passwords at
-- sign-in, cash differences, voids, oversold stock, returns, clock problems.
-- ---------------------------------------------------------------------------

-- args: { action_type?, from?, to?, page? }. Newest first, with who did it,
-- who approved it, and what it was about.
create or replace function public.pos_audit_log(auth jsonb, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_type text := nullif(args ->> 'action_type', '');
  v_from timestamptz;
  v_to timestamptz;
  v_page integer;
  v_total bigint;
  v_rows jsonb;
begin
  perform pos.require_owner(auth);
  v_from := pos.arg_time(args, 'from', 'From');
  v_to := pos.arg_time(args, 'to', 'To');
  v_page := greatest(1, coalesce(pos.arg_number(args, 'page', 'page')::integer, 1));

  with found as (
    select a from public.audit_logs a
    where (v_type is null or a.action_type = v_type)
      and (v_from is null or a.client_created_at >= v_from)
      and (v_to is null or a.client_created_at <= v_to)
  ), page as (
    select f.a from found f
    order by (f.a).client_created_at desc
    limit 200 offset (v_page - 1) * 200
  )
  select
    (select count(*) from found),
    (select jsonb_agg(to_jsonb(x.a) || jsonb_build_object(
              'actor', pos.user_brief((x.a).actor_id),
              'approver', pos.user_brief((x.a).approver_id),
              'subject', pos.audit_subject((x.a).entity_type, (x.a).entity_id))
            order by (x.a).client_created_at desc)
     from page x)
  into v_total, v_rows;

  return pos.page_json(v_rows, v_total, v_page, 200);
end $$;

-- ===========================================================================
-- Who may call what
-- ===========================================================================

-- Internals and owner tools: only the database owner (the SQL Editor).
revoke all on all functions in schema pos from public;

-- The API: callable with the app's public key. Each function checks the
-- terminal key or the person's sign-in itself.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'pos\_%'
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- Supabase's API notices new functions on its own; this makes sure.
notify pgrst, 'reload schema';
