-- Optional: a starting count of 100 in the store for every item that has no
-- stock yet, like the Laravel InitialStockSeeder, so a fresh setup shows
-- numbers instead of zeros. Skip this if you'll enter the real counts on the
-- Stock screen. Safe to run again: items that already have stock are left
-- alone.

with batches as (
  insert into public.stock_batches (product_id, location, received_at, qty_received, qty_good_remaining, qty_damaged, source, client_created_at)
  select p.id, 'store', now(), 100, 100, 0, 'receiving', now()
  from public.products p
  where not exists (select 1 from public.stock_batches b where b.product_id = p.id)
  returning id, product_id
)
insert into public.stock_movements (product_id, batch_id, delta, reason, reference_id, note, client_created_at)
select b.product_id, b.id, 100, 'stock_receipt', b.id, 'Starting stock count', now()
from batches b;
