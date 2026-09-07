<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AuditLog;
use App\Models\Sale;
use App\Models\StockBatch;
use App\Models\StockMovement;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class SalesController extends Controller
{
    public function index(Request $request)
    {
        Gate::authorize('view-sales');

        $query = Sale::with(['cashier:id,full_name'])->latest('client_created_at');

        $query->when($request->shift_id, fn ($q, $v) => $q->where('shift_id', $v));
        $query->when($request->status, fn ($q, $v) => $q->where('status', $v));
        $query->when($request->from, fn ($q, $v) => $q->where('client_created_at', '>=', $v));
        $query->when($request->to, fn ($q, $v) => $q->where('client_created_at', '<=', $v));

        return response()->json($query->paginate(50));
    }

    // POST /sales/{id}/void — restores the movement ledger by writing an
    // offsetting 'void' movement per original 'sale' movement, and (where
    // the sale was allocated to a specific batch) restores that batch's
    // qty_good_remaining. Sales aren't yet allocated against stock_batches
    // at checkout time (same open TODO as the FIFO allocator), so the
    // batch-restore branch is a no-op today and will start working on its
    // own once that's built — nothing here needs to change for that.
    public function void(Request $request, string $id)
    {
        Gate::authorize('approve-void');

        $data = $request->validate([
            'reason' => ['required', 'string', 'max:255'],
        ]);

        $sale = Sale::findOrFail($id);

        if ($sale->status !== 'completed') {
            return response()->json(['message' => 'Only a completed sale can be voided.'], 422);
        }

        DB::transaction(function () use ($sale, $data, $request) {
            $sale->update([
                'status' => 'voided',
                'voided_by' => $request->user()->id,
                'void_reason' => $data['reason'],
            ]);

            foreach (StockMovement::where('reference_id', $sale->id)->where('reason', 'sale')->get() as $movement) {
                StockMovement::create([
                    'product_id' => $movement->product_id,
                    'batch_id' => $movement->batch_id,
                    'terminal_id' => $movement->terminal_id,
                    'delta' => abs($movement->delta),
                    'reason' => 'void',
                    'reference_id' => $sale->id,
                    'actor_id' => $request->user()->id,
                    'client_created_at' => now(),
                ]);

                if ($movement->batch_id) {
                    StockBatch::where('id', $movement->batch_id)->increment('qty_good_remaining', abs($movement->delta));
                }
            }

            AuditLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'approver_id' => $request->user()->id,
                'action_type' => 'sale_voided',
                'entity_type' => 'sale',
                'entity_id' => $sale->id,
                'details' => ['reason' => $data['reason'], 'total_amount' => (string) $sale->total_amount],
                'client_created_at' => now(),
            ]);
        });

        return response()->json($sale->fresh());
    }
}
