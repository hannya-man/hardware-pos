<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class ActivityLogController extends Controller
{
    // GET /api/activity?actor_id=&shift_id=&from=&to=&event_type=
    // A cashier's own terminal never calls this — there's no screen for it
    // in their app — but the gate is what actually stops them if they ever
    // guessed the URL. Pattern review, not single-event catching: a
    // cashier who cancels orders at 5x their coworkers' rate is what this
    // is for, not any one cancelled order.
    //
    // Now eager-loads the actor's name — this is the actual fix for
    // "Staff Logs doesn't work": the screen was rendering a raw actor_id
    // because nothing here ever told it who that id belonged to.
    public function index(Request $request)
    {
        Gate::authorize('view-activity-log');

        $query = ActivityLog::with('actor:id,full_name,role')->latest('client_created_at');

        $query->when($request->actor_id, fn ($q, $v) => $q->where('actor_id', $v));
        $query->when($request->shift_id, fn ($q, $v) => $q->where('shift_id', $v));
        $query->when($request->event_type, fn ($q, $v) => $q->where('event_type', $v));
        $query->when($request->from, fn ($q, $v) => $q->where('client_created_at', '>=', $v));
        $query->when($request->to, fn ($q, $v) => $q->where('client_created_at', '<=', $v));

        return response()->json($query->paginate(50));
    }

    // Every routine action a cashier takes gets logged here — this is the
    // one write endpoint any authenticated terminal can call, since it's
    // the actor logging their own actions, not a privileged write.
    public function store(Request $request)
    {
        $data = $request->validate([
            'id' => ['required', 'uuid'],
            'shift_id' => ['nullable', 'uuid'],
            'event_type' => ['required', 'string'],
            'entity_type' => ['nullable', 'string'],
            'entity_id' => ['nullable', 'uuid'],
            'details' => ['nullable', 'array'],
            'client_created_at' => ['required', 'date'],
        ]);

        $data['actor_id'] = $request->user()->id;
        $data['terminal_id'] = $request->header('X-Terminal-Id', 'unknown');

        return response()->json(ActivityLog::firstOrCreate(['id' => $data['id']], $data), 201);
    }
}
