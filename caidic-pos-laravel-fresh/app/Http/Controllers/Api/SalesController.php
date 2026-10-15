<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Sale;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class SalesController extends Controller
{
    // GET /sales?from=...&to=...&status=...&shift_id=... — newest first,
    // with the items, the cashier, the credit customer (if any), and a void
    // waiting for approval (if any), plus `totals`: completed sales per
    // payment method over the whole range. Voids go through
    // VoidRequestController: two owners have to agree.
    public function index(Request $request)
    {
        Gate::authorize('view-sales');

        $filtered = Sale::query()
            ->when($request->shift_id, fn ($q, $v) => $q->where('shift_id', $v))
            ->when($request->status, fn ($q, $v) => $q->where('status', $v))
            ->when($request->from, fn ($q, $v) => $q->where('client_created_at', '>=', $v))
            ->when($request->to, fn ($q, $v) => $q->where('client_created_at', '<=', $v));

        $totals = (clone $filtered)->where('status', 'completed')
            ->groupBy('payment_method')
            ->selectRaw('payment_method, SUM(total_amount) as total')
            ->pluck('total', 'payment_method')
            ->map(fn ($total) => (float) $total);

        $page = $filtered->with([
            'cashier:id,full_name',
            'customer:id,name',
            'items:id,sale_id,name_snapshot,quantity,unit_price_snapshot,line_total',
            'pendingVoid:id,sale_id,expires_at',
        ])->latest('client_created_at')->paginate(100);

        return response()->json([...$page->toArray(), 'totals' => $totals]);
    }
}
