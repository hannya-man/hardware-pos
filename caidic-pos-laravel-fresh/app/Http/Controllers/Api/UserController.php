<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Hash;

class UserController extends Controller
{
    // GET /users — the Staff Accounts table. manager+owner, same gate the
    // nav already uses to decide whether to show this screen.
    public function index(Request $request)
    {
        Gate::authorize('manage-users');

        return response()->json(
            User::orderBy('full_name')->get(['id', 'full_name', 'role', 'is_active'])
        );
    }

    public function store(Request $request)
    {
        Gate::authorize('manage-users');

        $data = $request->validate([
            'full_name' => ['required', 'string', 'max:255'],
            'role' => ['required', 'in:cashier,manager,owner'],
            'pin' => ['required', 'string', 'size:4'],
        ]);

        $user = User::create([
            'full_name' => $data['full_name'],
            'role' => $data['role'],
            'pin_hash' => Hash::make($data['pin']),
            'is_active' => true,
        ]);

        return response()->json($user, 201);
    }

    public function update(Request $request, string $id)
    {
        Gate::authorize('manage-users');

        $user = User::findOrFail($id);

        $data = $request->validate([
            'full_name' => ['sometimes', 'string', 'max:255'],
            'role' => ['sometimes', 'in:cashier,manager,owner'],
            'pin' => ['sometimes', 'string', 'size:4'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        if (isset($data['pin'])) {
            $data['pin_hash'] = Hash::make($data['pin']);
            unset($data['pin']);
        }

        $user->update($data);

        return response()->json($user);
    }
}
