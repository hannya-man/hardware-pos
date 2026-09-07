<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Supplier;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class SupplierController extends Controller
{
    // GET /suppliers — feeds the dropdown on Supplier Orders. No edit or
    // deactivate screen yet, deliberately — this is just enough to place
    // an order, not a supplier directory.
    public function index(Request $request)
    {
        Gate::authorize('manage-catalog');

        return response()->json(Supplier::where('is_active', true)->orderBy('name')->get());
    }

    public function store(Request $request)
    {
        Gate::authorize('manage-catalog');

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'contact_name' => ['nullable', 'string', 'max:255'],
            'phone' => ['nullable', 'string', 'max:50'],
            'email' => ['nullable', 'email', 'max:255'],
        ]);

        $supplier = Supplier::create($data + ['is_active' => true]);

        return response()->json($supplier, 201);
    }
}
