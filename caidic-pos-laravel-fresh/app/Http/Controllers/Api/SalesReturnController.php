<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AuditLog;
use App\Models\SalesReturn;
use App\Models\StockBatch;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class SalesReturnController extends Controller
{
    public function store(Request $request)
    {
        // The real boundary. Hiding "Returns" from a cashier's menu is a
        // convenience, not security — this line is what actually stops the
        // request if it isn't an owner token, regardless of what UI sent it.
        Gate::authorize('process-return');

        $data = $request->validate([
            'id' => ['required', 'uuid'],
            'original_sale_item_id' => ['nullable', 'uuid', 'exists:sale_items,id'],
            'product_id' => ['required', 'uuid', 'exists:products,id'],
            'quantity_returned' => ['required', 'numeric', 'min:0.001'],
            'condition' => ['required', 'in:good,damaged'],
            'reason' => ['nullable', 'string', 'max:255'],
            'client_created_at' => ['required', 'date'],
        ]);

        $return = DB::transaction(function () use ($data, $request) {
            $data['processed_by'] = $request->user()->id;
            $return = SalesReturn::create($data);

            // A good-condition return re-enters at the BACK of the FIFO
            // queue — dated now, not backdated to the original sale — a
            // damaged one goes straight into qty_damaged and is never
            // offered for sale.
            StockBatch::create([
                'product_id' => $data['product_id'],
                'location' => 'store',
                'received_at' => now(),
                'qty_received' => $data['quantity_returned'],
                'qty_good_remaining' => $data['condition'] === 'good' ? $data['quantity_returned'] : 0,
                'qty_damaged' => $data['condition'] === 'damaged' ? $data['quantity_returned'] : 0,
                'source' => 'return_accepted',
                'reference_id' => $return->id,
                'created_by' => $request->user()->id,
                'client_created_at' => $data['client_created_at'],
            ]);

            AuditLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'approver_id' => $request->user()->id,
                'action_type' => 'return_accepted',
                'entity_type' => 'sales_return',
                'entity_id' => $return->id,
                'details' => $data,
                'client_created_at' => $data['client_created_at'],
            ]);

            return $return;
        });

        return response()->json($return, 201);
    }
}
