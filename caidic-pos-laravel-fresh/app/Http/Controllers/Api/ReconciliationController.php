<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AuditLog;
use App\Models\DailyReconciliation;
use App\Models\Sale;
use App\Models\StockMovement;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class ReconciliationController extends Controller
{
    // What the system already believes moved today, for the closer to
    // check against the physical receipt/slip count. This is the live
    // in/out counter that runs all day, not just at closing.
    public function today(Request $request)
    {
        $date = $request->query('date', now()->toDateString());

        // 'sale' deltas are negative, 'void' deltas are the positive
        // offset created when that sale is later voided (see
        // SalesController::void()). Summing -delta across both reasons
        // nets a voided sale back to zero instead of still counting it
        // as stock that "went out" for the day.
        $out = StockMovement::whereIn('reason', ['sale', 'void'])
            ->whereDate('client_created_at', $date)
            ->sum(DB::raw('-delta'));

        $in = StockMovement::whereIn('reason', ['stock_receipt', 'transfer_in'])
            ->whereDate('client_created_at', $date)
            ->sum('delta');

        return response()->json(['system_qty_out' => (float) $out, 'system_qty_in' => (float) $in]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'id' => ['required', 'uuid'],
            'business_date' => ['required', 'date'],
            'physical_qty_out' => ['required', 'numeric'],
            'physical_qty_in' => ['required', 'numeric'],
            'notes' => ['nullable', 'string'],
            'client_created_at' => ['required', 'date'],
        ]);

        $system = $this->today(new Request(['date' => $data['business_date']]))->getData(true);

        $data['performed_by'] = $request->user()->id;
        $data['system_qty_out'] = $system['system_qty_out'];
        $data['system_qty_in'] = $system['system_qty_in'];
        $data['discrepancy_out'] = $data['physical_qty_out'] - $system['system_qty_out'];
        $data['discrepancy_in'] = $data['physical_qty_in'] - $system['system_qty_in'];

        $hasDiscrepancy = abs($data['discrepancy_out']) > 0.001 || abs($data['discrepancy_in']) > 0.001;

        if ($hasDiscrepancy) {
            // A mismatch needs an owner's eyes, whoever entered the counts.
            Gate::authorize('sign-off-reconciliation');
            $data['status'] = 'discrepancy_acknowledged';
        } else {
            $data['status'] = 'matched';
        }

        $reconciliation = DB::transaction(function () use ($data, $request, $hasDiscrepancy) {
            $reconciliation = DailyReconciliation::updateOrCreate(['business_date' => $data['business_date']], $data);

            if ($hasDiscrepancy) {
                AuditLog::create([
                    'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
                    'actor_id' => $request->user()->id,
                    'approver_id' => $request->user()->id,
                    'action_type' => 'day_close_discrepancy',
                    'entity_type' => 'daily_reconciliation',
                    'entity_id' => $reconciliation->id,
                    'details' => $data,
                    'client_created_at' => $data['client_created_at'],
                ]);
            }

            return $reconciliation;
        });

        return response()->json($reconciliation, 201);
    }
}
