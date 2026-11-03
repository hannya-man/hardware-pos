-- RRC Merchandise POS: orders wait for stock. A sale can take more than is in
-- stock: what there isn't goes on order (an on_order stock movement, with no
-- batch) and is filled from the next stock that comes in (pos.fill_orders in
-- 20261015000001_pos_api.sql), so a count never goes below 0. Safe to run
-- more than once, like every file after 20261016000000_security_controls.sql.

alter table public.stock_movements drop constraint if exists stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check check (reason in (
  'sale', 'void_restock', 'manual_adjustment', 'stock_receipt',
  'stocktake_correction', 'transfer_out', 'transfer_in', 'damage', 'on_order'));

-- Until now a till could sell past a batch's count, and the batch went below
-- 0 ("batch_oversold" on the Audit log). Each such batch is settled against
-- the item's other batches in the same place, which keeps that place's count
-- the same. If the place's count itself was below 0, it stops at 0: those
-- items were handed over long ago, and nothing waits for them.
do $$
declare
  v_short record;
  v_batch record;
  v_owed numeric;
  v_take numeric;
begin
  for v_short in
    select b.id, b.product_id, b.location, -b.qty_good_remaining as short_by
    from public.stock_batches b where b.qty_good_remaining < 0
    order by b.product_id, b.location, b.received_at
  loop
    v_owed := v_short.short_by;
    for v_batch in
      select b.id, b.qty_good_remaining from public.stock_batches b
      where b.product_id = v_short.product_id and b.location = v_short.location and b.qty_good_remaining > 0
      order by b.received_at
    loop
      exit when v_owed <= 0;
      v_take := least(v_owed, v_batch.qty_good_remaining);
      update public.stock_batches set qty_good_remaining = qty_good_remaining - v_take where id = v_batch.id;
      insert into public.stock_movements (product_id, batch_id, delta, reason, note, client_created_at)
      values (v_short.product_id, v_batch.id, -v_take, 'stocktake_correction', 'Settled a batch that was sold below 0', now());
      v_owed := v_owed - v_take;
    end loop;

    update public.stock_batches set qty_good_remaining = 0 where id = v_short.id;
    insert into public.stock_movements (product_id, batch_id, delta, reason, note, client_created_at)
    values (v_short.product_id, v_short.id, v_short.short_by, 'stocktake_correction', 'Settled a batch that was sold below 0', now());
  end loop;
end $$;
