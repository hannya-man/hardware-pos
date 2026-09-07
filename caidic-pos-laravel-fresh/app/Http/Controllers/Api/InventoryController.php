<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Product;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class InventoryController extends Controller
{
    // GET /inventory/stock?include_archived=1
    // Per-product position across both locations, plus damaged units.
    // Never selects cost_price — this feeds Price List too, and that
    // screen is the one most likely to get printed or shown around.
    public function stock(Request $request)
    {
        Gate::authorize('manage-catalog');

        $includeArchived = $request->boolean('include_archived');

        $products = Product::with(['batches' => fn ($q) => $q
                ->where(fn ($q2) => $q2->where('qty_good_remaining', '>', 0)->orWhere('qty_damaged', '>', 0))
                ->select('id', 'product_id', 'location', 'qty_good_remaining', 'qty_damaged')])
            ->when(! $includeArchived, fn ($q) => $q->where('is_active', true))
            ->orderBy('name')
            ->get(['id', 'sku', 'name', 'unit', 'unit_price', 'reorder_level', 'is_active']);

        return response()->json($products->map(function ($product) {
            $storeGood = $product->batches->where('location', 'store')->sum('qty_good_remaining');
            $warehouseGood = $product->batches->where('location', 'warehouse')->sum('qty_good_remaining');

            return [
                'id' => $product->id, 'sku' => $product->sku, 'name' => $product->name,
                'unit' => $product->unit, 'unit_price' => $product->unit_price,
                'reorder_level' => $product->reorder_level, 'is_active' => $product->is_active,
                'store_good' => (float) $storeGood, 'warehouse_good' => (float) $warehouseGood,
                'damaged' => (float) $product->batches->sum('qty_damaged'),
                'low_stock' => ($storeGood + $warehouseGood) <= $product->reorder_level,
            ];
        }));
    }
}
