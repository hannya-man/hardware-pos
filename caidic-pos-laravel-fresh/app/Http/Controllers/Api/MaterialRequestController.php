<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\MaterialRequest;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class MaterialRequestController extends Controller
{
    // GET /material-requests?status=pending
    // What cashiers submit from POS Terminal arrives here through the
    // normal offline sync (see SyncController — material_request is
    // MERGEABLE), not through a POST on this controller. This is
    // deliberately read (+fulfill) only.
    public function index(Request $request)
    {
        Gate::authorize('manage-catalog');

        $query = MaterialRequest::with('requestedBy:id,full_name')->latest('client_created_at');
        $query->when($request->status, fn ($q, $v) => $q->where('status', $v));

        return response()->json($query->paginate(50));
    }

    public function fulfill(Request $request, string $id)
    {
        Gate::authorize('manage-catalog');

        $materialRequest = MaterialRequest::findOrFail($id);

        if ($materialRequest->status !== 'pending') {
            return response()->json(['message' => 'This list was already handled.'], 422);
        }

        $materialRequest->update([
            'status' => 'fulfilled',
            'fulfilled_by' => $request->user()->id,
            'fulfilled_at' => now(),
        ]);

        return response()->json($materialRequest);
    }
}
