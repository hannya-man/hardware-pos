<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\Product;
use App\Models\StockBatch;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

class CatalogController extends Controller
{
    public function index(Request $request)
    {
        $serverTime = now();
        $since = Carbon::parse($request->query('since', '1970-01-01T00:00:00Z'));

        $products = Product::where('updated_at', '>=', $since)
            ->get()
            ->makeHidden(['cost_price']);

        $categories = Category::where('updated_at', '>=', $since)->get();

        $users = User::where('updated_at', '>=', $since)
            ->get()
            ->makeVisible(['pin_hash', 'totp_secret']);

        $stockBatches = StockBatch::where('updated_at', '>=', $since)->get();

        return response()->json([
            'server_time' => $serverTime->toIso8601String(),
            'products' => $products,
            'categories' => $categories,
            'users' => $users,
            'stock_batches' => $stockBatches,
        ]);
    }
}