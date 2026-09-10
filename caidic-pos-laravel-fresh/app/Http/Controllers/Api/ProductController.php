<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Category;
use App\Models\Product;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;

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

    // GET /api/products/next-sku?category_id=... — suggests a ready-made
    // item code, so nobody has to invent one by hand on the Add New Item
    // screen. Looks at the codes already used by items in that category
    // (e.g. existing "CEM-004" suggests "CEM-005" next). If the category
    // has no items in it yet, it builds a short code from the category's
    // own name instead. Either way this is only a suggestion — the field
    // on screen can still be typed over.
    public function nextSku(Request $request)
    {
        Gate::authorize('manage-catalog');

        $data = $request->validate([
            'category_id' => ['required', 'uuid', 'exists:categories,id'],
        ]);

        $skus = Product::where('category_id', $data['category_id'])->pluck('sku');

        $prefix = null;
        if ($skus->isNotEmpty()) {
            $prefix = $skus
                ->map(fn ($sku) => strtoupper(Str::before($sku, '-')))
                ->countBy()
                ->sortDesc()
                ->keys()
                ->first();
        }

        if (! $prefix) {
            $category = Category::findOrFail($data['category_id']);
            $prefix = collect(preg_split('/[\s&,]+/', $category->name))
                ->filter()
                ->map(fn ($word) => strtoupper(substr($word, 0, 1)))
                ->join('');
            $prefix = $prefix !== '' ? substr($prefix, 0, 4) : 'ITM';
        }

        $nextNumber = 1;
        foreach ($skus as $sku) {
            if (Str::startsWith(strtoupper($sku), $prefix.'-') && preg_match('/-(\d+)$/', $sku, $m)) {
                $nextNumber = max($nextNumber, ((int) $m[1]) + 1);
            }
        }

        return response()->json(['sku' => $prefix.'-'.str_pad((string) $nextNumber, 3, '0', STR_PAD_LEFT)]);
    }

    // POST /api/products — manager+owner (manage-catalog). Creates a
    // brand new catalog entry. cost_price stays null here, same as
    // everywhere else in the app.
    //
    // barcode is generated automatically — an internal 12-digit code
    // starting with "200", a block that real manufacturer barcodes don't
    // use, so it never collides with an item's own printed code. Nobody
    // has to invent this by hand either; it isn't even shown on the form.
    public function store(Request $request)
    {
        Gate::authorize('manage-catalog');

        $data = $request->validate([
            'sku' => ['required', 'string', 'max:100', 'unique:products,sku'],
            'name' => ['required', 'string', 'max:255'],
            'category_id' => ['required', 'uuid', 'exists:categories,id'],
            'unit' => ['required', 'string', 'max:20'],
            'unit_price' => ['required', 'numeric', 'min:0'],
            'reorder_level' => ['nullable', 'numeric', 'min:0'],
        ]);

        do {
            $barcode = '200'.str_pad((string) random_int(0, 999999999), 9, '0', STR_PAD_LEFT);
        } while (Product::where('barcode', $barcode)->exists());

        $product = Product::create([
            'sku' => $data['sku'],
            'barcode' => $barcode,
            'name' => $data['name'],
            'category_id' => $data['category_id'],
            'unit' => $data['unit'],
            'unit_price' => $data['unit_price'],
            'cost_price' => null,
            'reorder_level' => $data['reorder_level'] ?? 10,
            'is_active' => true,
        ]);

        ActivityLog::create([
            'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
            'actor_id' => $request->user()->id,
            'shift_id' => null,
            'event_type' => 'item_added_to_catalog',
            'entity_type' => 'product',
            'entity_id' => $product->id,
            'details' => ['product_name' => $product->name, 'sku' => $product->sku],
            'client_created_at' => now(),
        ]);

        return response()->json($product, 201);
    }

    // PATCH /api/products/{id} — manager+owner. Now covers the full set
    // of everyday edits from the Stock List: name, unit, price, low
    // stock level, and archive/restore. It used to only accept price and
    // archive/restore. cost_price and sku still aren't editable here on
    // purpose.
    //
    // Every kind of change writes to activity_log, so Staff Logs shows
    // exactly what changed and who changed it.
    public function update(Request $request, string $id)
    {
        Gate::authorize('manage-catalog');

        $product = Product::findOrFail($id);
        $before = $product->only(['name', 'unit', 'unit_price', 'reorder_level', 'is_active']);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'unit' => ['sometimes', 'string', 'max:20'],
            'unit_price' => ['sometimes', 'numeric', 'min:0'],
            'reorder_level' => ['sometimes', 'numeric', 'min:0'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        $product->update($data);

        if (array_key_exists('unit_price', $data) && (float) $before['unit_price'] !== (float) $data['unit_price']) {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'shift_id' => null,
                'event_type' => 'price_changed',
                'entity_type' => 'product',
                'entity_id' => $product->id,
                'details' => ['product_name' => $product->name, 'from' => $before['unit_price'], 'to' => $data['unit_price']],
                'client_created_at' => now(),
            ]);
        }

        if (array_key_exists('is_active', $data) && $before['is_active'] !== $data['is_active']) {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'shift_id' => null,
                'event_type' => $data['is_active'] ? 'item_restored' : 'item_archived',
                'entity_type' => 'product',
                'entity_id' => $product->id,
                'details' => ['product_name' => $product->name],
                'client_created_at' => now(),
            ]);
        }

        $otherChanges = collect(['name', 'unit', 'reorder_level'])
            ->filter(fn ($field) => array_key_exists($field, $data) && (string) $before[$field] !== (string) $data[$field])
            ->values();

        if ($otherChanges->isNotEmpty()) {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'shift_id' => null,
                'event_type' => 'item_details_updated',
                'entity_type' => 'product',
                'entity_id' => $product->id,
                'details' => ['product_name' => $product->name, 'changed_fields' => $otherChanges->all()],
                'client_created_at' => now(),
            ]);
        }

        return response()->json($product->only(['id', 'sku', 'name', 'unit', 'unit_price', 'reorder_level', 'is_active']));
    }
}
