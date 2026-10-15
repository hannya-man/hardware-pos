<?php

namespace App\Http\Controllers\Api\Concerns;

use App\Models\ActivityLog;
use App\Models\ShiftLog;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

trait LogsActivity
{
    // Adds an entry to Staff activity for an action taken through the API
    // (price change, staff edit, void, ...). It's tied to the shift of whoever
    // is signed in on the terminal (X-Shift-Id) when the server already has
    // it. $actor is for someone acting at another person's screen, like an
    // owner approving a void there. A logging failure never turns into an
    // error for the person saving.
    protected function recordActivity(Request $request, string $eventType, string $entityType, string $entityId, array $details = [], ?User $actor = null): void
    {
        $shiftId = $request->header('X-Shift-Id');

        try {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'ip_address' => $request->ip(),
                'actor_id' => ($actor ?? $request->user())->id,
                'shift_id' => $shiftId && ShiftLog::whereKey($shiftId)->exists() ? $shiftId : null,
                'event_type' => $eventType,
                'entity_type' => $entityType,
                'entity_id' => $entityId,
                'details' => $details,
                'client_created_at' => now(),
            ]);
        } catch (\Throwable $e) {
            Log::warning('activity log write failed', [
                'event_type' => $eventType,
                'entity_type' => $entityType,
                'entity_id' => $entityId,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
