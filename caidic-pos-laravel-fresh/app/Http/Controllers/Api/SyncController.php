<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\AuditLog;
use App\Models\CreditPayment;
use App\Models\Customer;
use App\Models\MaterialRequest;
use App\Models\Sale;
use App\Models\SaleItem;
use App\Models\ShiftLog;
use App\Models\StockBatch;
use App\Models\StockMovement;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class SyncController extends Controller
{
    // Once synced, a retried push is a no-op, never an overwrite: historical
    // events, and pick lists, whose status only the server changes (picked
    // up, or cancelled by a void) and a late resend must not undo.
    private const IMMUTABLE = [
        'stock_movement' => StockMovement::class,
        'audit_log' => AuditLog::class,
        'activity_log' => ActivityLog::class,
        'credit_payment' => CreditPayment::class,
        'material_request' => MaterialRequest::class,
    ];

    // Written once but can legitimately change later on the terminal (a
    // shift gets closed, a customer's phone number gets fixed).
    private const MERGEABLE = [
        'sale_item' => SaleItem::class,
        'shift_log' => ShiftLog::class,
        'customer' => Customer::class,
    ];

    // Body: { items: [{ id, entity_type, payload }, ...] }
    // Response: per-item ok/error, so the terminal clears what succeeded and
    // retries the rest (flushOutbox() in sync-worker.js).
    public function push(Request $request)
    {
        $items = $request->validate(['items' => ['required', 'array']])['items'];
        $results = [];

        foreach ($items as $item) {
            try {
                $this->pushOne($item);
                $results[$item['id']] = ['ok' => true];
            } catch (\Throwable $e) {
                Log::warning('sync push failed', ['item' => $item['id'], 'type' => $item['entity_type'] ?? null, 'error' => $e->getMessage()]);
                $results[$item['id']] = ['ok' => false, 'error' => $e->getMessage()];
            }
        }

        return response()->json(['results' => $results]);
    }

    private function pushOne(array $item): void
    {
        $type = $item['entity_type'];
        $payload = $item['payload'];

        if ($type === 'sale') {
            $this->pushSale($payload);

            return;
        }

        if ($type === 'stock_batch') {
            $this->pushStockBatch($payload);

            return;
        }

        $model = self::IMMUTABLE[$type] ?? self::MERGEABLE[$type] ?? null;
        if (! $model) {
            throw new \InvalidArgumentException("unknown entity_type: {$type}");
        }

        // The device isn't a trustworthy source for its own IP address, so
        // it's stamped from the connection that delivered this sync.
        if ($type === 'activity_log') {
            $payload['ip_address'] = request()->ip();
        }

        // A sale's pick list that arrives after the sale was already voided:
        // nothing to hand over.
        if ($type === 'material_request' && ! empty($payload['sale_id'])
            && Sale::whereKey($payload['sale_id'])->where('status', 'voided')->exists()) {
            $payload['status'] = 'cancelled';
        }

        $this->upsert($model, $payload, insertOnly: array_key_exists($type, self::IMMUTABLE));
    }

    // Saves a terminal's record under the terminal's own id. `id` is left out
    // of every model's $fillable, so a plain create() would quietly swap in a
    // new server id, and everything pointing at the terminal's id (sales at a
    // shift, items at a sale) would then be rejected.
    private function upsert(string $class, array $payload, bool $insertOnly = false): Model
    {
        $model = $class::find($payload['id']);
        if ($model && $insertOnly) {
            return $model;
        }

        $model ??= new $class;
        $model->fill($payload);
        $model->id = $payload['id'];
        $model->save();

        return $model;
    }

    // A completed sale is three things at once — the sale, its lines, and the
    // stock it drew down — written atomically so a partial sync can never
    // leave stock decremented without a sale, or the reverse. The FIFO choice
    // was already made on the terminal; this just applies it. Insert-only: a
    // resend (after a timeout, say) must not overwrite a sale that has been
    // voided on the server since.
    private function pushSale(array $payload): void
    {
        DB::transaction(function () use ($payload) {
            $this->upsert(Sale::class, $payload['sale'], insertOnly: true);

            foreach ($payload['items'] as $itemData) {
                $this->upsert(SaleItem::class, $itemData, insertOnly: true);
            }

            foreach ($payload['movements'] as $movementData) {
                if (StockMovement::whereKey($movementData['id'])->exists()) {
                    continue; // applied on an earlier attempt — don't decrement twice
                }

                // A batch this server never received (a stale terminal copy)
                // shouldn't block the sale; the movement is kept unallocated.
                if (! empty($movementData['batch_id']) && ! StockBatch::whereKey($movementData['batch_id'])->exists()) {
                    $movementData['batch_id'] = null;
                }

                $this->upsert(StockMovement::class, $movementData, insertOnly: true);

                if (empty($movementData['batch_id'])) {
                    continue;
                }

                // lockForUpdate serializes two ONLINE terminals hitting the same
                // batch. Two OFFLINE terminals may both have drawn from it; the
                // sale already happened, so apply it and flag any oversell.
                $batch = StockBatch::where('id', $movementData['batch_id'])->lockForUpdate()->first();
                $resulting = $batch->qty_good_remaining + $movementData['delta'];
                $batch->increment('qty_good_remaining', $movementData['delta']);

                if ($resulting < 0) {
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
        });
    }

    // A device with a wrong clock could date a batch next month, and it would
    // never look "oldest" for FIFO. Anything more than a few hours ahead of the
    // server is clamped to server time, and logged.
    private function pushStockBatch(array $payload): void
    {
        $receivedAt = Carbon::parse($payload['received_at']);

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

        $batch = $this->upsert(StockBatch::class, $payload);

        // Receiving counts as "items in" for the day, via a stock_receipt
        // movement. Guarded so a retried push can't log it twice.
        if (! StockMovement::where('reference_id', $batch->id)->where('reason', 'stock_receipt')->exists()) {
            StockMovement::create([
                'product_id' => $batch->product_id,
                'batch_id' => $batch->id,
                'terminal_id' => $payload['terminal_id'] ?? null,
                'delta' => $batch->qty_good_remaining + $batch->qty_damaged,
                'reason' => 'stock_receipt',
                'reference_id' => $batch->id,
                'actor_id' => $payload['created_by'] ?? null,
                'client_created_at' => $payload['client_created_at'] ?? now(),
            ]);
        }
    }
}
