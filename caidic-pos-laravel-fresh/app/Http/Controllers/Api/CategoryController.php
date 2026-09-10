<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Category;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class CategoryController extends Controller
{
    // GET /api/categories — a small, direct way for the Add New Item
    // screen to get the category list over Sanctum, separate from the
    // terminal's offline catalog sync. Used as a backup whenever this
    // device's own local copy of the categories is empty, so "no
    // categories" can't block adding a new item.
    public function index(Request $request)
    {
        Gate::authorize('manage-catalog');

        return response()->json(Category::where('is_active', true)->orderBy('name')->get(['id', 'name']));
    }
}
