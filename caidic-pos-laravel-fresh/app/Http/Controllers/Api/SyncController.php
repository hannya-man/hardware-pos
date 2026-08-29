<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\AuditLog;
use App\Models\Sale;
use App\Models\SaleItem;
use App\Models\ShiftLog;
use App\Models\StockBatch;
use App\Models\StockMovement;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class SyncController extends Controller
{
    // Tables that are historical events: once synced, a retried push is a
    // silent no-op, never an overwrite. Mirrors IMMUTABLE_TABLES in the
    // original sync-worker.js.
    private const IMMUTABLE = [
        'stock_movement' => StockMovement::class,
        'audit_log' => AuditLog::class,
        'activity_log' => ActivityLog::class,
    ];

    // Mergeable: written once, but CAN legitimately change later (a sale
    // gets voided, a shift gets closed, a batch's qty_good_remaining drops).
    private const MERGEABLE = [
        'sale_item' => SaleItem::class,
        'shift_log' => ShiftLog::class,
    ];

    // Body: { items: [{ id, entity_type, entity_id, payload }, ...] }
    // Response: per-item ok/error so the client can clear succeeded items
    // and leave failed ones in its local outbox for the next retry —
    // exactly what flushOutbox() in sync-worker.js already expects.
    public function push(Request $request)
    {
        $items = $request->validate(['items' => ['required', 'array']])['items'];
        $results = [];

        foreach ($items as $item) {
            try {
                $this->pushOne($item);
                $results[$item['id']] = ['ok' => true];
            } catch (\Throwable $e) {
                Log::warning('sync push failed', ['item' => $item['id'], 'error' => $e->getMessage()]);
                $results[$item['id']] = ['ok' => false, 'error' => $e->getMessage()];
            }
        }

        return response()->json(['results' => $results]);
    }

    private function pushOne(array $item): void
    {
        if ($item['entity_type'] === 'sale') {
            $this->pushSale($item['payload']);

            return;
        }

        if ($item['entity_type'] === 'stock_batch') {
            $this->pushStockBatch($item['payload']);

            return;
        }

        $model = self::IMMUTABLE[$item['entity_type']] ?? self::MERGEABLE[$item['entity_type']] ?? null;

        if (! $model) {
            throw new \InvalidArgumentException("unknown entity_type: {$item['entity_type']}");
        }

        if (array_key_exists($item['entity_type'], self::IMMUTABLE)) {
            // Insert-once: if the id already exists, this retry is a no-op.
            $model::firstOrCreate(['id' => $item['payload']['id']], $item['payload']);
        } else {
            $model::updateOrCreate(['id' => $item['payload']['id']], $item['payload']);
        }
    }

    // A completed sale is three things at once — the sale row, its line
    // items, and the stock it drew down — written atomically so a partial
    // sync can never leave stock decremented without a matching sale, or
    // vice versa. The FIFO decision itself already happened offline on the
    // terminal (see completeSale() client-side); every movement here already
    // carries the batch_id it drew from. This endpoint just applies it.
    private function pushSale(array $payload): void
    {
        DB::transaction(function () use ($payload) {
            Sale::updateOrCreate(['id' => $payload['sale']['id']], $payload['sale']);

            foreach ($payload['items'] as $itemData) {
                SaleItem::updateOrCreate(['id' => $itemData['id']], $itemData);
            }

            foreach ($payload['movements'] as $movementData) {
                $existing = StockMovement::find($movementData['id']);
                if ($existing) {
                    continue; // already applied on a prior sync attempt — skip, don't double-decrement
                }

                StockMovement::create($movementData);

                if (! empty($movementData['batch_id'])) {
                    // lockForUpdate serializes two ONLINE terminals hitting
                    // the same batch at the same instant — that part is
                    // fully preventable. What it can't prevent is two
                    // terminals that were both OFFLINE and both decided,
                    // independently, that this was the oldest open batch —
                    // by the time either syncs, the decision already
                    // happened. So: apply it, then check the result.
                    $batch = StockBatch::where('id', $movementData['batch_id'])->lockForUpdate()->first();

                    if ($batch) {
                        $resulting = $batch->qty_good_remaining + $movementData['delta'];
                        $batch->increment('qty_good_remaining', $movementData['delta']);

                        if ($resulting < 0) {
                            // Not blocked — the sale already happened and the
                            // customer already paid, undoing it now would be
                            // worse than the discrepancy itself. Logged so it
                            // surfaces in the owner's reconciliation instead
                            // of sitting as a silent negative number.
                            AuditLog::create([
                                'terminal_id' => $payload['sale']['terminal_id'] ?? 'unknown',
                                'actor_id' => $movementData['actor_id'] ?? null,
                                'approver_id' => null,
                                'action_type' => 'batch_oversold',
                                'entity_type' => 'stock_batch',
                                'entity_id' => $batch->id,
                                'details' => ['oversold_by' => abs($resulting), 'movement_id' => $movementData['id']],
                                'client_created_at' => $movementData['client_created_at'],
                            ]);
                        }
                    }
                }
            }
        });
    }

    // A device with a wrong system clock is the one offline problem that
    // doesn't just create a discrepancy — it can silently corrupt FIFO
    // ordering for everyone once it syncs. A batch dated next month would
    // never look "oldest" and would sit unsold behind correctly-dated stock
    // indefinitely. Anything claiming to be received more than a few hours
    // ahead of the server's own clock gets clamped to server time instead
    // of trusted blindly, and logged so it's visible, not silently altered.
    private function pushStockBatch(array $payload): void
    {
        $receivedAt = \Illuminate\Support\Carbon::parse($payload['received_at']);

        if ($receivedAt->isAfter(now()->addHours(6))) {
            AuditLog::create([
                'terminal_id' => $payload['terminal_id'] ?? 'unknown',
                'actor_id' => $payload['created_by'] ?? null,
                'approver_id' => null,
                'action_type' => 'timestamp_anomaly_clamped',
                'entity_type' => 'stock_batch',
                'entity_id' => $payload['id'],
                'details' => ['claimed_received_at' => $payload['received_at'], 'clamped_to' => now()->toIso8601String()],
                'client_created_at' => now(),
            ]);
            $payload['received_at'] = now();
        }

        StockBatch::updateOrCreate(['id' => $payload['id']], $payload);
    }
}
