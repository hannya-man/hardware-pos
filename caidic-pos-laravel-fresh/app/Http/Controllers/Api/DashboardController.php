<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Customer;
use App\Models\Product;
use App\Models\Sale;
use App\Models\ShiftLog;
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

        $sales = Sale::where('status', 'completed')->whereBetween('client_created_at', [$start, $end]);
        $byMethod = (clone $sales)->groupBy('payment_method')
            ->selectRaw('payment_method, sum(total_amount) as total')
            ->pluck('total', 'payment_method')
            ->map(fn ($total) => (float) $total);

        $topSelling = StockMovement::query()
            ->join('products', 'products.id', '=', 'stock_movements.product_id')
            ->where('stock_movements.reason', 'sale')
            ->whereBetween('stock_movements.client_created_at', [$start, $end])
            ->groupBy('products.id', 'products.name', 'products.unit')
            ->orderByDesc('units_sold')
            ->limit(5)
            ->get(['products.id', 'products.name', 'products.unit', DB::raw('SUM(ABS(stock_movements.delta)) as units_sold')]);

        // Current-state facts, not period-scoped.
        $stockValue = DB::table('stock_batches')
            ->join('products', 'products.id', '=', 'stock_batches.product_id')
            ->where('products.is_active', true)
            ->groupBy('stock_batches.location')
            ->selectRaw('stock_batches.location, SUM(stock_batches.qty_good_remaining * products.unit_price) as value')
            ->pluck('value', 'location');

        $lowStockCount = Product::where('is_active', true)
            ->with(['batches' => fn ($q) => $q->where('qty_good_remaining', '>', 0)->select('id', 'product_id', 'qty_good_remaining')])
            ->get(['id', 'reorder_level'])
            ->filter(fn ($p) => $p->batches->sum('qty_good_remaining') <= $p->reorder_level)
            ->count();

        // In stock but unsold for 30 days, most money tied up first.
        $notSelling = DB::table('stock_batches')
            ->join('products', 'products.id', '=', 'stock_batches.product_id')
            ->where('products.is_active', true)
            ->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('stock_movements')
                ->whereColumn('stock_movements.product_id', 'products.id')
                ->where('stock_movements.reason', 'sale')
                ->where('stock_movements.client_created_at', '>=', now()->subDays(30)->toIso8601String()))
            ->groupBy('products.id', 'products.name', 'products.unit', 'products.unit_price')
            ->havingRaw('SUM(stock_batches.qty_good_remaining) > 0')
            ->orderByRaw('SUM(stock_batches.qty_good_remaining) * products.unit_price DESC')
            ->limit(5)
            ->get(['products.id', 'products.name', 'products.unit',
                DB::raw('SUM(stock_batches.qty_good_remaining) as units'),
                DB::raw('SUM(stock_batches.qty_good_remaining) * products.unit_price as value')]);

        $onShift = ShiftLog::where('status', 'open')->with('cashier:id,full_name')->latest('started_at')->get()
            ->map(fn ($s) => ['name' => $s->cashier?->full_name, 'started_at' => $s->started_at]);

        return response()->json([
            'period' => $period,
            'sales' => [
                'total' => (float) (clone $sales)->sum('total_amount'),
                'count' => (clone $sales)->count(),
                'by_method' => $byMethod,
            ],
            'credit_owed' => round(Customer::query()->select('customers.*')->withBalance()->get()->sum('owed'), 2),
            'stock' => [
                'store_value' => (float) ($stockValue['store'] ?? 0),
                'warehouse_value' => (float) ($stockValue['warehouse'] ?? 0),
                'low_stock_count' => $lowStockCount,
            ],
            'on_shift' => $onShift,
            'top_selling' => $topSelling,
            'not_selling' => $notSelling,
        ]);
    }

    // "Today" means the store's day, not UTC's (which would start at 8 AM in
    // Manila). Bounds go out with their offset so Postgres compares correctly.
    private function periodBounds(string $period): array
    {
        $now = now(config('app.store_timezone'));

        $bounds = match ($period) {
            'week' => [$now->copy()->startOfWeek(), $now->copy()->endOfWeek()],
            'month' => [$now->copy()->startOfMonth(), $now->copy()->endOfMonth()],
            'year' => [$now->copy()->startOfYear(), $now->copy()->endOfYear()],
            default => [$now->copy()->startOfDay(), $now->copy()->endOfDay()],
        };

        return array_map(fn ($date) => $date->toIso8601String(), $bounds);
    }
}
