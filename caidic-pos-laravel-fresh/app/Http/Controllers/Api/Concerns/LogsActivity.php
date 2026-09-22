<?php

namespace App\Http\Controllers\Api\Concerns;

use App\Models\ActivityLog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

trait LogsActivity
{
    // Writes an entry to Staff Logs. This is wrapped in a try/catch on
    // purpose: Staff Logs is a record of what happened, it is not a gate
    // on whether the action is allowed to happen. Editing a staff member
    // or changing a price must still succeed even if the log write
    // itself hits a problem (an unexpected schema difference, for
    // example) — that is what turned "change a staff member's name"
    // into a 500 error before this was added. Failures are written to
    // the normal Laravel log instead of being thrown.
    protected function recordActivity(Request $request, string $eventType, string $entityType, string $entityId, array $details = []): void
    {
        try {
            ActivityLog::create([
                'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                'ip_address' => $request->ip(),
                'actor_id' => $request->user()->id,
                'shift_id' => null,
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
