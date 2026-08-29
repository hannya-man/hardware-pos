<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    private const MAX_PIN_ATTEMPTS = 5;
    private const LOCKOUT_MINUTES = 1;

    // Terminal shows the staff grid from GET /api/staff (name + role only,
    // never the pin_hash — see the hidden attribute on User), person taps
    // their name, then this endpoint checks the PIN for that one user.
    public function login(Request $request)
    {
        $data = $request->validate([
            'user_id' => ['required', 'uuid'],
            'pin' => ['required', 'string', 'size:4'],
        ]);

        $user = User::where('id', $data['user_id'])->where('is_active', true)->first();

        if (! $user) {
            throw ValidationException::withMessages(['pin' => 'That PIN isn\'t right — try again.']);
        }

        if ($user->locked_until && $user->locked_until->isFuture()) {
            throw ValidationException::withMessages(['pin' => 'Too many attempts — try again in a minute.']);
        }

        if (! Hash::check($data['pin'], $user->pin_hash)) {
            $attempts = $user->failed_pin_attempts + 1;
            $user->update([
                'failed_pin_attempts' => $attempts,
                'locked_until' => $attempts >= self::MAX_PIN_ATTEMPTS
                    ? now()->addMinutes(self::LOCKOUT_MINUTES)
                    : null,
            ]);

            throw ValidationException::withMessages(['pin' => 'That PIN isn\'t right — try again.']);
        }

        $user->update(['failed_pin_attempts' => 0, 'locked_until' => null]);

        return response()->json([
            'user' => $user,
            'token' => $user->createToken($request->header('X-Terminal-Id', 'unknown'))->plainTextToken,
        ]);
    }

    public function logout(Request $request)
    {
        $request->user()->currentAccessToken()->delete();

        return response()->noContent();
    }
}
