<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Api\Concerns\LogsActivity;
use App\Http\Controllers\Controller;
use App\Models\MaterialRequest;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

// Pick lists for the stockroom. Every sale makes one, and a list can also be
// sent without charging; both arrive through the normal offline sync
// (SyncController), not through a POST here. This is read + mark-picked-up
// only, open to all staff: whoever works the stockroom has to see them.
class MaterialRequestController extends Controller
{
    use LogsActivity;

    // GET /material-requests?status=pending — newest first, with the sale
    // (its Ref no. is on the customer's slip) and the credit customer.
    public function index(Request $request)
    {
        Gate::authorize('use-pick-lists');

        $query = MaterialRequest::with([
            'requestedBy:id,full_name',
            'fulfilledBy:id,full_name',
            'sale:id,payment_method,customer_id,status',
            'sale.customer:id,name',
        ])->latest('client_created_at');
        $query->when($request->status, fn ($q, $v) => $q->where('status', $v));

        return response()->json($query->paginate(50));
    }

    // PATCH /material-requests/{id}/fulfill — the items were handed over.
    public function fulfill(Request $request, string $id)
    {
        Gate::authorize('use-pick-lists');

        $materialRequest = MaterialRequest::with('sale:id,status')->findOrFail($id);

        if ($materialRequest->status === 'cancelled' || $materialRequest->sale?->status === 'voided') {
            return response()->json(['message' => 'This sale was voided. Don\'t hand these items over.'], 422);
        }
        if ($materialRequest->status !== 'pending') {
            return response()->json(['message' => 'This list was already picked up.'], 422);
        }

        $materialRequest->update([
            'status' => 'fulfilled',
            'fulfilled_by' => $request->user()->id,
            'fulfilled_at' => now(),
        ]);

        $this->recordActivity($request, 'pick_list_done', 'material_request', $materialRequest->id, array_filter([
            'item_count' => count($materialRequest->items ?? []),
            'sale_ref' => $materialRequest->sale_id ? strtoupper(substr($materialRequest->sale_id, 0, 8)) : null,
        ]));

        return response()->json($materialRequest);
    }
}
