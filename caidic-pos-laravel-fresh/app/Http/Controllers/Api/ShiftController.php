<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ShiftLog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class ShiftController extends Controller
{
    public function index(Request $request)
    {
        Gate::authorize('view-sales');

        $shifts = ShiftLog::with('cashier:id,full_name')
            ->withSum(['sales as sales_total' => fn ($q) => $q->where('status', 'completed')], 'total_amount')
            ->latest('started_at')
            ->paginate(50);

        return response()->json($shifts);
    }
}
