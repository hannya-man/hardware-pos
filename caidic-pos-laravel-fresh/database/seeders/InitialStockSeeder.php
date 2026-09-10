<?php

namespace Database\Seeders;

use App\Models\Product;
use App\Models\StockBatch;
use App\Models\StockMovement;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class InitialStockSeeder extends Seeder
{
    // Gives every product that has no stock batch yet a starting count of
    // 100 units at the store. Safe to run more than once: a product that
    // already has at least one batch (a real receiving, a return, a
    // manual count) is left alone, so re-running this never doubles up
    // stock that's already there.
    //
    // id is set explicitly with Str::uuid() on both creates below rather
    // than left for HasUuid's creating() hook to fill in. DatabaseSeeder
    // uses WithoutModelEvents, which turns that hook off for the whole
    // seeding run (including this seeder, since it's called from there),
    // the same reason ProductCatalogSeeder already had to do this.
    private const STARTING_QTY = 100;

    public function run(): void
    {
        $created = 0;

        Product::whereDoesntHave('batches')->each(function (Product $product) use (&$created) {
            DB::transaction(function () use ($product) {
                $now = now();
                $batchId = (string) Str::uuid();

                StockBatch::create([
                    'id' => $batchId,
                    'product_id' => $product->id,
                    'location' => 'store',
                    'received_at' => $now,
                    'qty_received' => self::STARTING_QTY,
                    'qty_good_remaining' => self::STARTING_QTY,
                    'qty_damaged' => 0,
                    // 'initial_stock' isn't in the database's allowed list
                    // for this column (found out the hard way) — 'receiving'
                    // is, since Receive Stock already uses it successfully.
                    'source' => 'receiving',
                    'reference_id' => null,
                    'created_by' => null,
                    'client_created_at' => $now,
                ]);

                // Matches the same 'stock_receipt' reason Reconciliation's
                // "items in" counter already watches for, so this shows up
                // consistently everywhere stock movements are read from.
                StockMovement::create([
                    'id' => (string) Str::uuid(),
                    'product_id' => $product->id,
                    'batch_id' => $batchId,
                    'terminal_id' => null,
                    'delta' => self::STARTING_QTY,
                    'reason' => 'stock_receipt',
                    'reference_id' => $batchId,
                    'actor_id' => null,
                    'note' => 'Starting stock count',
                    'client_created_at' => $now,
                ]);
            });

            $created++;
        });

        $this->command?->info("Starting stock of ".self::STARTING_QTY." added for {$created} item(s).");
    }
}
