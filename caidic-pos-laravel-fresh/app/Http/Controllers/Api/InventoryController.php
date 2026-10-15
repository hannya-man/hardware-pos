<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Product;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class InventoryController extends Controller
{
    // GET /inventory/stock?include_archived=1
    // Each item's good stock in the store and the warehouse, plus damaged
    // units. Never includes cost_price. Quantities are changed through
    // ProductController (edit an item) or a delivery synced from a terminal.
    public function stock(Request $request)
    {
        Gate::authorize('manage-catalog');

        $includeArchived = $request->boolean('include_archived');

        $products = Product::with(['batches' => fn ($q) => $q
                ->where(fn ($q2) => $q2->where('qty_good_remaining', '>', 0)->orWhere('qty_damaged', '>', 0))
                ->select('id', 'product_id', 'location', 'qty_good_remaining', 'qty_damaged')])
            ->when(! $includeArchived, fn ($q) => $q->where('is_active', true))
            ->orderBy('name')
            ->get(['id', 'sku', 'name', 'category_id', 'unit', 'unit_price', 'reorder_level', 'is_active']);

        return response()->json($products->map(function ($product) {
            $storeGood = $product->batches->where('location', 'store')->sum('qty_good_remaining');
            $warehouseGood = $product->batches->where('location', 'warehouse')->sum('qty_good_remaining');

            return [
                'id' => $product->id, 'sku' => $product->sku, 'name' => $product->name,
                'category_id' => $product->category_id,
                'unit' => $product->unit, 'unit_price' => $product->unit_price,
                'reorder_level' => $product->reorder_level, 'is_active' => $product->is_active,
                'store_good' => (float) $storeGood, 'warehouse_good' => (float) $warehouseGood,
                'damaged' => (float) $product->batches->sum('qty_damaged'),
                'low_stock' => ($storeGood + $warehouseGood) <= $product->reorder_level,
            ];
        }));
    }
}
