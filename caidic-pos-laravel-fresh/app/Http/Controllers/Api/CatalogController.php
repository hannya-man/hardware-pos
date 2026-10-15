<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\Customer;
use App\Models\Product;
use App\Models\Sale;
use App\Models\StockBatch;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

// GET /catalog?since=... — everything a terminal keeps offline, changed since
// its last pull. Users include pin_hash/totp_secret for offline sign-in.
// voided_sales lists sales voided since then, so the terminal that made one
// stops counting it (in its shift's expected cash, for one).
class CatalogController extends Controller
{
    public function index(Request $request)
    {
        $serverTime = now();
        $since = Carbon::parse($request->query('since', '1970-01-01T00:00:00Z'));

        return response()->json([
            'server_time' => $serverTime->toIso8601String(),
            'products' => Product::where('updated_at', '>=', $since)->get()->makeHidden(['cost_price']),
            'categories' => Category::where('updated_at', '>=', $since)->get(),
            'users' => User::where('updated_at', '>=', $since)->get()->makeVisible(['pin_hash', 'totp_secret']),
            'stock_batches' => StockBatch::where('updated_at', '>=', $since)->get(),
            'customers' => Customer::where('updated_at', '>=', $since)->get(['id', 'name', 'phone', 'is_active', 'updated_at']),
            'voided_sales' => Sale::where('status', 'voided')->where('updated_at', '>=', $since)->pluck('id'),
        ]);
    }
}
