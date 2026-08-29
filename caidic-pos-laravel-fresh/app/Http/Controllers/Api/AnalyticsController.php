<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\CycleCount;
use App\Models\Product;
use App\Models\StockMovement;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class AnalyticsController extends Controller
{
    // GET /api/analytics/movers — no cron, no stored job: this runs the
    // moment the owner opens the dashboard, against a rolling 7-day window
    // rather than one calendar day, so a single quiet Tuesday doesn't get
    // a normal SKU flagged as a slow mover.
    public function movers(Request $request)
    {
        Gate::authorize('view-analytics');

        $days = (int) $request->query('days', 7);

        $ranked = StockMovement::query()
            ->join('products', 'products.id', '=', 'stock_movements.product_id')
            ->where('stock_movements.reason', 'sale')
            ->where('stock_movements.client_created_at', '>=', now()->subDays($days))
            ->groupBy('products.id', 'products.name', 'products.sku')
            ->orderByDesc('units_moved')
            ->get([
                'products.id', 'products.name', 'products.sku',
                DB::raw('SUM(ABS(stock_movements.delta)) as units_moved'),
            ]);

        return response()->json([
            'window_days' => $days,
            'top_movers' => $ranked->take(10)->values(),
            'slow_movers' => $ranked->reverse()->take(5)->values(),
        ]);
    }

    public function storeCycleCount(Request $request)
    {
        Gate::authorize('view-analytics');

        $data = $request->validate([
            'id' => ['required', 'uuid'],
            'business_date' => ['required', 'date'],
            'product_id' => ['required', 'uuid', 'exists:products,id'],
            'reason' => ['required', 'in:top_mover,slow_mover,manual'],
            'physical_quantity' => ['required', 'numeric', 'min:0'],
            'client_created_at' => ['required', 'date'],
        ]);

        $product = Product::findOrFail($data['product_id']);
        $systemQty = $product->goodStockAt('store') + $product->goodStockAt('warehouse');

        $data['counted_by'] = $request->user()->id;
        $data['system_quantity'] = $systemQty;
        $data['variance'] = $data['physical_quantity'] - $systemQty;

        $count = CycleCount::create($data);

        // A variance corrects the system, but only through the same
        // stocktake_correction movement type your regular counts already
        // use — never a silent overwrite of a batch.
        if (abs($count->variance) > 0.001) {
            StockMovement::create([
                'product_id' => $product->id,
                'terminal_id' => null,
                'delta' => $count->variance,
                'reason' => 'stocktake_correction',
                'reference_id' => $count->id,
                'actor_id' => $request->user()->id,
                'note' => "Cycle count correction ({$data['reason']})",
                'client_created_at' => $data['client_created_at'],
            ]);
        }

        return response()->json($count, 201);
    }
}
