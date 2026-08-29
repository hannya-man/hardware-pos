<?php

namespace App\Http\Middleware;

use App\Models\Terminal;
use Closure;
use Illuminate\Http\Request;

class AuthenticateTerminal
{
    // Guards /api/catalog and /api/sync/push — the two endpoints a terminal
    // has to be able to reach with zero regard for who's currently on shift.
    // A cashier logging in offline, ringing up sales all morning, and
    // syncing at noon should never depend on a Sanctum token that expired,
    // got revoked from another device, or was never fetched because the
    // terminal was offline at login time. Who actually performed each
    // action still travels in the payload itself (cashier_id, actor_id) —
    // this middleware only proves "a registered device," not "which person."
    public function handle(Request $request, Closure $next)
    {
        $rawKey = $request->header('X-Terminal-Key');

        if (! $rawKey) {
            return response()->json(['message' => 'Missing terminal key'], 401);
        }

        $terminal = Terminal::findByRawKey($rawKey);

        if (! $terminal) {
            return response()->json(['message' => 'Unknown or deactivated terminal'], 401);
        }

        $terminal->update(['last_seen_at' => now()]);
        $request->attributes->set('terminal', $terminal);

        return $next($request);
    }
}
