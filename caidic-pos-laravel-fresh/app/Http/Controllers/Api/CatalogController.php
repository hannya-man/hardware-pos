<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\Product;
use App\Models\StockBatch;
use App\Models\User;
use Illuminate\Http\Request;

class CatalogController extends Controller
{
    // GET /api/catalog?since=2026-08-01T00:00:00Z — terminal-key auth (see
    // AuthenticateTerminal), not tied to who's locally logged in. Because of
    // that, this can never conditionally include cost_price based on role —
    // there's no per-user session here to check. So it's simpler than the
    // earlier version: cost_price never leaves through this endpoint, to
    // any terminal, full stop. See ProductController::show() for where an
    // owner actually gets it, fetched live, one product at a time.
    //
    // pin_hash IS included below, deliberately — staff login (see
    // verifyStaffLogin() in input-handler.js) must work fully offline, so
    // the bcrypt hash has to be cached locally for comparison. This is a
    // real security tradeoff: PIN hashes now sit in the browser's
    // IndexedDB. Acceptable here because it's a bcrypt hash (not the raw
    // PIN), the terminal itself is already gated by AuthenticateTerminal's
    // api key, and this is a single-location retail terminal, not a
    // public-facing app. makeVisible() only overrides User::$hidden for
    // this response — pin_hash stays hidden everywhere else in the app.
    public function index(Request $request)
    {
        $since = $request->query('since', '1970-01-01T00:00:00Z');

        $products = Product::where('updated_at', '>', $since)
            ->orderBy('updated_at')
            ->get(['id', 'sku', 'barcode', 'name', 'category_id', 'unit', 'unit_price', 'reorder_level', 'is_active', 'updated_at']);

        $batches = StockBatch::where('updated_at', '>', $since)
            ->where('qty_good_remaining', '>', 0)
            ->get();

        return response()->json([
            'products' => $products,
            'categories' => Category::where('is_active', true)->get(),
            'users' => User::where('is_active', true)
                ->get(['id', 'full_name', 'role', 'pin_hash'])
                ->makeVisible('pin_hash'),
            'stock_batches' => $batches,
            'server_time' => now()->toIso8601String(),
        ]);
    }
}