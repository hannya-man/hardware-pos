<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\CreditPayment;
use App\Models\Sale;
use App\Models\ShiftLog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

// A shift runs from a person's clock-in to their clock-out on one terminal.
class ShiftController extends Controller
{
    // GET /shifts?cashier_id=... — newest first, with what each one sold.
    public function index(Request $request)
    {
        Gate::authorize('view-sales');

        $shifts = ShiftLog::with('cashier:id,full_name,role')
            ->withCount(['sales as sales_count' => fn ($q) => $q->where('status', 'completed')])
            ->withSum(['sales as sales_total' => fn ($q) => $q->where('status', 'completed')], 'total_amount')
            ->when($request->cashier_id, fn ($q, $v) => $q->where('cashier_id', $v))
            ->latest('started_at')
            ->paginate(50);

        return response()->json($shifts);
    }

    // GET /shifts/{id} — the shift plus everything that happened during it,
    // for the timeline: sales, credit payments taken, and every logged action.
    public function show(string $id)
    {
        Gate::authorize('view-sales');

        $shift = ShiftLog::with('cashier:id,full_name,role')->findOrFail($id);

        $sales = Sale::with(['items:id,sale_id,name_snapshot,quantity,unit_price_snapshot,line_total', 'customer:id,name'])
            ->where('shift_id', $id)
            ->orderBy('client_created_at')
            ->get();

        $payments = CreditPayment::with('customer:id,name')
            ->where('shift_id', $id)
            ->orderBy('client_created_at')
            ->get();

        $activity = ActivityLog::where('shift_id', $id)
            ->orderBy('client_created_at')
            ->limit(3000)
            ->get(['id', 'event_type', 'entity_type', 'entity_id', 'details', 'ip_address', 'client_created_at']);

        return response()->json(compact('shift', 'sales', 'payments', 'activity'));
    }
}
