<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Product;
use App\Models\PurchaseOrder;
use App\Models\Sale;
use App\Models\ShiftLog;
use App\Models\StockBatch;
use App\Models\StockMovement;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class DashboardController extends Controller
{
    // GET /dashboard?period=today|week|month|year
    public function summary(Request $request)
    {
        Gate::authorize('view-dashboard');

        $period = $request->query('period', 'today');
        [$start, $end] = $this->periodBounds($period);

        $completedSales = Sale::where('status', 'completed')
            ->whereBetween('client_created_at', [$start, $end]);

        $topSelling = StockMovement::query()
            ->join('products', 'products.id', '=', 'stock_movements.product_id')
            ->where('stock_movements.reason', 'sale')
            ->whereBetween('stock_movements.client_created_at', [$start, $end])
            ->groupBy('products.id', 'products.name')
            ->orderByDesc('units_sold')
            ->limit(5)
            ->get(['products.id', 'products.name', DB::raw('SUM(ABS(stock_movements.delta)) as units_sold')]);

        $retailValue = DB::table('stock_batches')
            ->join('products', 'products.id', '=', 'stock_batches.product_id')
            ->sum(DB::raw('stock_batches.qty_good_remaining * products.unit_price'));

        // Not period-scoped — stock alerts and who's on shift right now
        // are current-state facts, not "this week's" version of a fact.
        $lowStockCount = Product::where('is_active', true)
            ->with(['batches' => fn ($q) => $q->where('qty_good_remaining', '>', 0)->select('id', 'product_id', 'qty_good_remaining')])
            ->get(['id', 'reorder_level'])
            ->filter(fn ($p) => $p->batches->sum('qty_good_remaining') <= $p->reorder_level)
            ->count();

        $openShift = ShiftLog::where('status', 'open')->with('cashier:id,full_name')->latest('started_at')->first();

        return response()->json([
            'period' => $period,
            'sales_activity' => ['revenue' => (float) (clone $completedSales)->sum('total_amount')],
            'sales_orders' => ['order_count' => (clone $completedSales)->count()],
            'active_items' => Product::where('is_active', true)->count(),
            'top_selling' => $topSelling,
            'purchase_orders' => ['pending' => PurchaseOrder::where('status', 'pending')->count()],
            'stock_alerts' => ['low_stock_count' => $lowStockCount],
            'register_status' => $openShift
                ? ['open' => true, 'cashier' => $openShift->cashier?->full_name, 'started_at' => $openShift->started_at]
                : ['open' => false],
            'inventory_summary' => [
                'good_units_on_hand' => (float) StockBatch::sum('qty_good_remaining'),
                'damaged_units' => (float) StockBatch::sum('qty_damaged'),
                'retail_value_on_hand' => (float) $retailValue,
            ],
        ]);
    }

    private function periodBounds(string $period): array
    {
        $now = now();

        return match ($period) {
            'week' => [$now->copy()->startOfWeek(), $now->copy()->endOfWeek()],
            'month' => [$now->copy()->startOfMonth(), $now->copy()->endOfMonth()],
            'year' => [$now->copy()->startOfYear(), $now->copy()->endOfYear()],
            default => [$now->copy()->startOfDay(), $now->copy()->endOfDay()],
        };
    }
}
