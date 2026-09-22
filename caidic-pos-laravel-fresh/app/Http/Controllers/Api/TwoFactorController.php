<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Api\Concerns\LogsActivity;
use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\TotpService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class TwoFactorController extends Controller
{
    use LogsActivity;

    // POST /users/{id}/2fa/setup — starts setup for an owner account.
    // Generates a new secret and returns it for manual entry into an
    // authenticator app (no QR code image here, just the code itself —
    // every authenticator app supports typing a code in by hand). This
    // does NOT turn two-factor on yet; that only happens once a real
    // code from the app is confirmed in verify() below. Calling this
    // again before confirming just replaces the pending secret, so
    // starting over is always safe.
    public function setup(Request $request, string $id)
    {
        Gate::authorize('manage-users');

        $user = User::findOrFail($id);
        if ($user->role !== 'owner') {
            return response()->json(['message' => 'Two-factor login is only available for owner accounts.'], 422);
        }

        $secret = TotpService::generateSecret();
        $user->update(['totp_secret' => $secret, 'totp_enabled' => false]);

        return response()->json([
            'secret' => $secret,
            'otpauth_url' => TotpService::provisioningUri($secret, $user->full_name),
        ]);
    }

    // POST /users/{id}/2fa/verify — confirms the app was set up
    // correctly by checking one real code from it, then turns
    // two-factor login on for this account.
    public function verify(Request $request, string $id)
    {
        Gate::authorize('manage-users');

        $user = User::findOrFail($id);
        $data = $request->validate(['code' => ['required', 'string']]);

        if (! $user->totp_secret || ! TotpService::verify($user->totp_secret, $data['code'])) {
            return response()->json(['message' => 'That code did not match. Try again.'], 422);
        }

        $user->update(['totp_enabled' => true]);

        $this->recordActivity($request, 'two_factor_enabled', 'user', $user->id, ['staff_name' => $user->full_name]);

        return response()->json(['enabled' => true]);
    }

    // POST /users/{id}/2fa/disable
    public function disable(Request $request, string $id)
    {
        Gate::authorize('manage-users');

        $user = User::findOrFail($id);
        $user->update(['totp_secret' => null, 'totp_enabled' => false]);

        $this->recordActivity($request, 'two_factor_disabled', 'user', $user->id, ['staff_name' => $user->full_name]);

        return response()->json(['enabled' => false]);
    }
}
