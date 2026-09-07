<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\PurchaseOrder;
use App\Models\StockBatch;
use App\Models\StockMovement;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;

class PurchaseOrderController extends Controller
{
    public function index(Request $request)
    {
        Gate::authorize('manage-catalog');

        $query = PurchaseOrder::with('supplier:id,name')->latest('client_created_at');
        $query->when($request->status, fn ($q, $v) => $q->where('status', $v));

        return response()->json($query->paginate(50));
    }

    public function store(Request $request)
    {
        Gate::authorize('manage-catalog');

        $data = $request->validate([
            'supplier_id' => ['required', 'uuid', 'exists:suppliers,id'],
            'items' => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'uuid', 'exists:products,id'],
            'items.*.sku_snapshot' => ['required', 'string'],
            'items.*.name_snapshot' => ['required', 'string'],
            'items.*.quantity_ordered' => ['required', 'numeric', 'min:0.001'],
            'items.*.unit_cost' => ['nullable', 'numeric', 'min:0'],
            'expected_date' => ['nullable', 'date'],
            'notes' => ['nullable', 'string'],
        ]);

        $po = PurchaseOrder::create([
            'supplier_id' => $data['supplier_id'],
            'po_number' => 'PO-'.now()->format('ymd').'-'.strtoupper(Str::random(4)),
            'status' => 'pending',
            'items' => $data['items'],
            'notes' => $data['notes'] ?? null,
            'ordered_by' => $request->user()->id,
            'expected_date' => $data['expected_date'] ?? null,
            'client_created_at' => now(),
        ]);

        return response()->json($po, 201);
    }

    // PATCH /purchase-orders/{id}/receive — marks the whole PO received in
    // one step and actually adds the ordered quantities to Store stock,
    // the same way manual Receive Stock does: a StockBatch plus a
    // StockMovement (reason 'stock_receipt', same reason Reconciliation's
    // "items in" counter looks for). No partial-line receiving yet — a PO
    // is all-or-nothing for now, same simplicity level as Material Pick
    // Lists' fulfilled/pending.
    public function receive(Request $request, string $id)
    {
        Gate::authorize('manage-catalog');

        $po = PurchaseOrder::findOrFail($id);

        if ($po->status !== 'pending') {
            return response()->json(['message' => 'Only a pending purchase order can be received.'], 422);
        }

        DB::transaction(function () use ($po, $request) {
            foreach ($po->items as $item) {
                $batch = StockBatch::create([
                    'product_id' => $item['product_id'],
                    'location' => 'store',
                    'received_at' => now(),
                    'qty_received' => $item['quantity_ordered'],
                    'qty_good_remaining' => $item['quantity_ordered'],
                    'qty_damaged' => 0,
                    'source' => 'purchase_order',
                    'reference_id' => $po->id,
                    'created_by' => $request->user()->id,
                    'client_created_at' => now(),
                ]);

                StockMovement::create([
                    'product_id' => $item['product_id'],
                    'batch_id' => $batch->id,
                    'terminal_id' => null,
                    'delta' => $item['quantity_ordered'],
                    'reason' => 'stock_receipt',
                    'reference_id' => $po->id,
                    'actor_id' => $request->user()->id,
                    'note' => "Received against {$po->po_number}",
                    'client_created_at' => now(),
                ]);
            }

            $po->update(['status' => 'received', 'received_at' => now()]);
        });

        return response()->json($po->fresh());
    }
}
