<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Category;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class CategoryController extends Controller
{
    public function index(Request $request)
    {
        Gate::authorize('manage-catalog');

        return response()->json(Category::where('is_active', true)->orderBy('name')->get(['id', 'name']));
    }
}