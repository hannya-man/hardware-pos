<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Product;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class ProductController extends Controller
{
    // GET /api/products/{id} — Sanctum-authenticated, owner only. The admin
    // app calls this the moment it opens a product's edit screen, not on
    // catalog sync. This is the one place cost_price is ever transmitted.
    public function show(Request $request, string $id)
    {
        Gate::authorize('view-analytics'); // same trust tier as margins/reconciliation — reusing the gate rather than adding a near-duplicate one

        return response()->json(Product::findOrFail($id));
    }

    // PATCH /api/products/{id} — manager+owner, not owner-only like show().
    // Deliberately narrow: unit_price and is_active (archive/restore) only.
    // cost_price editing isn't built yet and shouldn't ride in on a
    // manager-accessible endpoint once it eventually is.
    public function update(Request $request, string $id)
    {
        Gate::authorize('manage-catalog');

        $product = Product::findOrFail($id);

        $data = $request->validate([
            'unit_price' => ['sometimes', 'numeric', 'min:0'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        $product->update($data);

        return response()->json($product->only(['id', 'sku', 'name', 'unit_price', 'is_active']));
    }
}
