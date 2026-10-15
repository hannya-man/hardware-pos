<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\Product;
use App\Models\StockBatch;
use App\Models\StockMovement;

// Sets a product's good quantity at one location to an exact number. The
// difference goes through the batch ledger like every other stock change:
// an increase opens a new batch, a decrease draws down the oldest batches
// first. Nothing ever writes a total straight onto a column. Call it inside
// a DB transaction.
class StockLedger
{
    public function setQuantity(Product $product, string $location, float $quantity, ?string $actorId, string $note, string $increaseReason = 'stocktake_correction'): float
    {
        $current = (float) $product->batches()->where('location', $location)->sum('qty_good_remaining');
        $delta = round($quantity - $current, 3);

        if ($delta > 0) {
            $this->add($product, $location, $delta, $actorId, $note, $increaseReason);
        } elseif ($delta < 0) {
            $this->remove($product, $location, -$delta, $actorId, $note);
        }

        return $delta;
    }

    private function add(Product $product, string $location, float $quantity, ?string $actorId, string $note, string $reason): void
    {
        $batch = StockBatch::create([
            'product_id' => $product->id,
            'location' => $location,
            'received_at' => now(),
            'qty_received' => $quantity,
            'qty_good_remaining' => $quantity,
            'qty_damaged' => 0,
            'source' => 'receiving',
            'reference_id' => null,
            'created_by' => $actorId,
            'client_created_at' => now(),
        ]);

        $this->movement($product, $batch->id, $quantity, $reason, $actorId, $note);
    }

    private function remove(Product $product, string $location, float $quantity, ?string $actorId, string $note): void
    {
        $remaining = $quantity;

        $batches = $product->batches()
            ->where('location', $location)
            ->where('qty_good_remaining', '>', 0)
            ->orderBy('received_at')
            ->lockForUpdate()
            ->get();

        foreach ($batches as $batch) {
            if ($remaining <= 0) {
                break;
            }
            $take = min($remaining, (float) $batch->qty_good_remaining);
            $batch->decrement('qty_good_remaining', $take);
            $this->movement($product, $batch->id, -$take, 'stocktake_correction', $actorId, $note);
            $remaining = round($remaining - $take, 3);
        }

        if ($remaining > 0.001) {
            // Asked for less than zero at this location; record what couldn't apply.
            AuditLog::create([
                'terminal_id' => 'admin-app',
                'actor_id' => $actorId,
                'approver_id' => null,
                'action_type' => 'manual_stock_adjustment',
                'entity_type' => 'product',
                'entity_id' => $product->id,
                'details' => ['location' => $location, 'short_by' => $remaining, 'note' => $note],
                'client_created_at' => now(),
            ]);
        }
    }

    private function movement(Product $product, string $batchId, float $delta, string $reason, ?string $actorId, string $note): void
    {
        StockMovement::create([
            'product_id' => $product->id,
            'batch_id' => $batchId,
            'terminal_id' => null,
            'delta' => $delta,
            'reason' => $reason,
            'reference_id' => $batchId,
            'actor_id' => $actorId,
            'note' => $note,
            'client_created_at' => now(),
        ]);
    }
}
