<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    // A terminal signs people in offline from its synced copy of the staff
    // list; this swaps the same user password for a server token, for the
    // screens that read the server.
    public function login(Request $request)
    {
        $data = $request->validate([
            'user_id' => ['required', 'uuid'],
            // 4 digits for cashiers, 6 for owners (see UserController).
            'pin' => ['required', 'string', 'regex:/^(\d{4}|\d{6})$/'],
        ]);

        $user = User::where('id', $data['user_id'])->where('is_active', true)->first();

        if (! $user) {
            throw ValidationException::withMessages(['pin' => 'That password isn\'t right — try again.']);
        }

        $user->assertPin($data['pin']);

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
