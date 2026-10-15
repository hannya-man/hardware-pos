<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Api\Concerns\LogsActivity;
use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class UserController extends Controller
{
    use LogsActivity;

    // GET /users — the Staff Accounts table (and the Staff Logs account
    // picker, which reuses this same endpoint). Only active accounts are
    // returned unless include_archived is explicitly passed — the same
    // pattern InventoryController::stock() already uses for archived
    // products — so a deactivated staff member now only ever turns up in
    // Archives, not in either of those two lists.
    public function index(Request $request)
    {
        Gate::authorize('manage-users');

        $includeArchived = $request->boolean('include_archived');

        return response()->json(
            User::when(! $includeArchived, fn ($q) => $q->where('is_active', true))
                ->orderBy('full_name')
                ->get(['id', 'full_name', 'role', 'is_active', 'totp_enabled'])
        );
    }

    public function store(Request $request)
    {
        Gate::authorize('manage-users');

        $data = $request->validate([
            'full_name' => ['required', 'string', 'max:255'],
            'role' => ['required', 'in:cashier,owner'],
            'pin' => ['required', 'string', 'regex:/^[0-9]+$/'],
        ]);

        $this->assertPinLength($data['pin'], $data['role']);

        $user = User::create([
            'full_name' => $data['full_name'],
            'role' => $data['role'],
            'pin_hash' => Hash::make($data['pin']),
            'is_active' => true,
        ]);

        $this->recordActivity($request, 'staff_added', 'user', $user->id, [
            'staff_name' => $user->full_name, 'role' => $user->role,
        ]);

        return response()->json($user, 201);
    }

    public function update(Request $request, string $id)
    {
        Gate::authorize('manage-users');

        $user = User::findOrFail($id);

        $data = $request->validate([
            'full_name' => ['sometimes', 'string', 'max:255'],
            'role' => ['sometimes', 'in:cashier,owner'],
            'pin' => ['sometimes', 'string', 'regex:/^[0-9]+$/'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        $this->assertKeepsAnOwner($user, $data);

        if (isset($data['pin'])) {
            // Uses the role being saved to if it's changing, otherwise
            // the account's current role, so a PIN reset is always
            // checked against the right length for that account.
            $this->assertPinLength($data['pin'], $data['role'] ?? $user->role);
        }

        $pinWasReset = isset($data['pin']);

        if (isset($data['pin'])) {
            $data['pin_hash'] = Hash::make($data['pin']);
            unset($data['pin']);
        }

        $user->update($data);

        // Every staff change lands in Staff Logs — role changes, PIN
        // resets, and deactivate/reactivate all show who did it. The PIN
        // itself is never logged, only the fact that it changed. This
        // write can never turn into a 500 for the person saving the
        // edit — see LogsActivity.
        if (array_key_exists('is_active', $data)) {
            $this->recordActivity(
                $request,
                $data['is_active'] ? 'staff_reactivated' : 'staff_deactivated',
                'user',
                $user->id,
                ['staff_name' => $user->full_name]
            );
        } elseif (array_key_exists('role', $data) || array_key_exists('full_name', $data) || $pinWasReset) {
            $this->recordActivity($request, 'staff_updated', 'user', $user->id, array_filter([
                'staff_name' => $user->full_name,
                'role' => $data['role'] ?? null,
                'pin_reset' => $pinWasReset ?: null,
            ]));
        }

        return response()->json($user);
    }

    // Only owners can manage staff, so the last active owner can't be turned
    // into a cashier or deactivated: nobody would be left to undo it.
    private function assertKeepsAnOwner(User $user, array $data): void
    {
        $stopsBeingOwner = (isset($data['role']) && $data['role'] !== 'owner')
            || (array_key_exists('is_active', $data) && ! $data['is_active']);

        if ($user->isOwner() && $user->is_active && $stopsBeingOwner
            && User::where('role', 'owner')->where('is_active', true)->count() <= 1) {
            throw ValidationException::withMessages([
                'role' => ['This is the only owner account, so it has to stay an active owner. Add another owner first.'],
            ]);
        }
    }

    // Owners get a 6-digit password, cashiers a 4-digit one — enforced here
    // as the real boundary, in addition to whatever length the form on
    // screen already asks for.
    private function assertPinLength(string $pin, string $role): void
    {
        $expected = $role === 'owner' ? 6 : 4;

        if (strlen($pin) !== $expected) {
            throw ValidationException::withMessages([
                'pin' => ["A {$role} account needs a {$expected}-digit password."],
            ]);
        }
    }
}
