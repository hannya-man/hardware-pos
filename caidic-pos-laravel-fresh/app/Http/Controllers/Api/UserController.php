<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
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

        // So it's visible in Staff Logs who added this account.
        ActivityLog::create([
            'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
            'actor_id' => $request->user()->id,
            'shift_id' => null,
            'event_type' => 'staff_added',
            'entity_type' => 'user',
            'entity_id' => $user->id,
            'details' => ['staff_name' => $user->full_name, 'role' => $user->role],
            'client_created_at' => now(),
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

        $pinWasReset = isset($data['pin']);

        if (isset($data['pin'])) {
            $data['pin_hash'] = Hash::make($data['pin']);
            unset($data['pin']);
        }

        $user->update($data);

        // Every staff change now lands in Staff Logs — role changes, PIN
        // resets, and deactivate/reactivate all show who did it. The PIN
        // itself is never logged, only the fact that it was changed.
        if (array_key_exists('is_active', $data)) {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'shift_id' => null,
                'event_type' => $data['is_active'] ? 'staff_reactivated' : 'staff_deactivated',
                'entity_type' => 'user',
                'entity_id' => $user->id,
                'details' => ['staff_name' => $user->full_name],
                'client_created_at' => now(),
            ]);
        } elseif (array_key_exists('role', $data) || array_key_exists('full_name', $data) || $pinWasReset) {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'actor_id' => $request->user()->id,
                'shift_id' => null,
                'event_type' => 'staff_updated',
                'entity_type' => 'user',
                'entity_id' => $user->id,
                'details' => array_filter([
                    'staff_name' => $user->full_name,
                    'role' => $data['role'] ?? null,
                    'pin_reset' => $pinWasReset ?: null,
                ]),
                'client_created_at' => now(),
            ]);
        }

        return response()->json($user);
    }
}
