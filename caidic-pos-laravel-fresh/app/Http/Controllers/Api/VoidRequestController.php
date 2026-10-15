<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Api\Concerns\LogsActivity;
use App\Http\Controllers\Controller;
use App\Models\AuditLog;
use App\Models\MaterialRequest;
use App\Models\Sale;
use App\Models\StockBatch;
use App\Models\StockMovement;
use App\Models\User;
use App\Models\VoidRequest;
use App\Services\TotpService;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

// Voiding a sale takes two owners. One asks (asking counts as their yes) and
// a second approves, from their own device or at the same screen with their
// password. If that hasn't happened ten minutes after the request, it lapses
// and the sale stays as it was. Any owner can say no, which ends it at once.
class VoidRequestController extends Controller
{
    use LogsActivity;

    private const DETAILS = [
        'requester:id,full_name',
        'resolver:id,full_name',
        'approvals.user:id,full_name',
        'sale.cashier:id,full_name',
        'sale.customer:id,name',
        'sale.items:id,sale_id,name_snapshot,quantity,unit_price_snapshot,line_total',
    ];

    // GET /void-requests — the ones still waiting, oldest first.
    public function index()
    {
        Gate::authorize('approve-void');
        VoidRequest::expireOverdue();

        return response()->json(
            VoidRequest::where('status', 'pending')->with(self::DETAILS)->oldest()->get()->map(fn ($v) => $this->present($v))
        );
    }

    // GET /void-requests/{id} — one request, so the screen that asked can follow it.
    public function show(string $id)
    {
        Gate::authorize('approve-void');
        VoidRequest::expireOverdue();

        return response()->json($this->present(VoidRequest::with(self::DETAILS)->findOrFail($id)));
    }

    // POST /sales/{id}/void-request {reason}
    public function store(Request $request, string $saleId)
    {
        Gate::authorize('approve-void');

        $data = $request->validate(['reason' => ['required', 'string', 'max:255']]);
        $sale = Sale::findOrFail($saleId);

        if ($sale->status !== 'completed') {
            throw ValidationException::withMessages(['sale' => 'Only a completed sale can be voided.']);
        }
        if (User::where('role', 'owner')->where('is_active', true)->count() < VoidRequest::APPROVALS_NEEDED) {
            throw ValidationException::withMessages(['sale' => 'A void needs two owners to approve it, and this store has only one owner account. Add the other owner in Staff first.']);
        }

        VoidRequest::expireOverdue();
        $alreadyWaiting = ValidationException::withMessages(['sale' => 'This sale already has a void waiting for approval.']);
        if (VoidRequest::where('sale_id', $sale->id)->where('status', 'pending')->exists()) {
            throw $alreadyWaiting;
        }

        try {
            $voidRequest = DB::transaction(function () use ($request, $sale, $data) {
                $voidRequest = VoidRequest::create([
                    'sale_id' => $sale->id,
                    'requested_by' => $request->user()->id,
                    'reason' => $data['reason'],
                    'status' => 'pending', // set here too: the column default never reaches this object
                    'expires_at' => now()->addMinutes(VoidRequest::MINUTES),
                ]);
                if ($request->user()->isOwner()) {
                    $voidRequest->approvals()->create(['user_id' => $request->user()->id]);
                }

                return $voidRequest;
            });
        } catch (UniqueConstraintViolationException) {
            throw $alreadyWaiting; // two owners asked at the same moment
        }

        $this->recordActivity($request, 'void_requested', 'sale', $sale->id, [
            'total_amount' => (string) $sale->total_amount, 'reason' => $data['reason'],
        ]);

        return response()->json($this->present($voidRequest->load(self::DETAILS)), 201);
    }

    // POST /void-requests/{id}/approve — the signed-in owner says yes.
    public function approve(Request $request, string $id)
    {
        Gate::authorize('approve-void');

        return $this->approveAs($request, $id, $request->user());
    }

    // POST /void-requests/{id}/approve-here {user_id, pin, code} — another
    // owner says yes at this screen with their own password, plus their
    // authenticator code if they use one. Whoever is signed in here only
    // provides the connection.
    public function approveHere(Request $request, string $id)
    {
        $data = $request->validate([
            'user_id' => ['required', 'uuid'],
            'pin' => ['required', 'string'],
            'code' => ['nullable', 'string'],
        ]);

        $owner = User::where('id', $data['user_id'])->where('role', 'owner')->where('is_active', true)->first();
        if (! $owner) {
            throw ValidationException::withMessages(['user_id' => 'Choose an owner.']);
        }

        $owner->assertPin($data['pin']);

        if ($owner->totp_enabled && ! TotpService::verify((string) $owner->totp_secret, (string) ($data['code'] ?? ''))) {
            throw ValidationException::withMessages(['code' => 'That authenticator code is wrong or has expired.']);
        }

        return $this->approveAs($request, $id, $owner);
    }

    // POST /void-requests/{id}/reject — an owner says no. From the owner who
    // asked, it withdraws the request instead.
    public function reject(Request $request, string $id)
    {
        Gate::authorize('approve-void');
        VoidRequest::expireOverdue();

        $voidRequest = DB::transaction(function () use ($request, $id) {
            $voidRequest = $this->lockOpen($id);
            $voidRequest->update([
                'status' => $voidRequest->requested_by === $request->user()->id ? 'cancelled' : 'rejected',
                'resolved_by' => $request->user()->id,
                'resolved_at' => now(),
            ]);

            return $voidRequest;
        });

        $voidRequest->load(self::DETAILS);
        $this->recordActivity($request, $voidRequest->status === 'cancelled' ? 'void_cancelled' : 'void_rejected', 'sale', $voidRequest->sale_id, [
            'total_amount' => (string) $voidRequest->sale->total_amount, 'reason' => $voidRequest->reason,
        ]);

        return response()->json($this->present($voidRequest));
    }

    private function approveAs(Request $request, string $id, User $owner)
    {
        VoidRequest::expireOverdue();

        [$voidRequest, $voided] = DB::transaction(function () use ($request, $id, $owner) {
            $voidRequest = $this->lockOpen($id);

            if ($voidRequest->approvals()->where('user_id', $owner->id)->exists()) {
                throw ValidationException::withMessages(['void' => "{$owner->full_name} already said yes. A different owner has to approve it."]);
            }
            $voidRequest->approvals()->create(['user_id' => $owner->id]);

            // Only yeses from people who are still active owners count.
            $yes = $voidRequest->approvals()->whereHas('user', fn ($q) => $q->where('role', 'owner')->where('is_active', true))->count();
            if ($yes < VoidRequest::APPROVALS_NEEDED) {
                return [$voidRequest, false];
            }

            $this->voidSale($request, $voidRequest, $owner);
            $voidRequest->update(['status' => 'approved', 'resolved_by' => $owner->id, 'resolved_at' => now()]);

            return [$voidRequest, true];
        });

        $voidRequest->load(self::DETAILS);
        $details = ['total_amount' => (string) $voidRequest->sale->total_amount, 'reason' => $voidRequest->reason];
        if ($voided) {
            $details['approved_by'] = $voidRequest->approvals->pluck('user.full_name')->implode(' and ');
        }
        $this->recordActivity($request, $voided ? 'sale_voided' : 'void_approved', 'sale', $voidRequest->sale_id, $details, $owner);

        return response()->json($this->present($voidRequest));
    }

    // The request, locked so two owners approving at the same moment can't
    // both void the sale. Says why when it's no longer open.
    private function lockOpen(string $id): VoidRequest
    {
        $voidRequest = VoidRequest::whereKey($id)->lockForUpdate()->firstOrFail();

        $problem = match (true) {
            $voidRequest->status === 'approved' => 'This sale was already voided.',
            $voidRequest->status === 'rejected' => 'Another owner already said no to this void.',
            $voidRequest->status === 'cancelled' => 'This void request was cancelled.',
            $voidRequest->status === 'expired', $voidRequest->expires_at->isPast() => 'This void request expired, so the sale was not voided.',
            default => null,
        };
        if ($problem) {
            throw ValidationException::withMessages(['void' => $problem]);
        }

        return $voidRequest;
    }

    // Puts the stock back (an offsetting void_restock movement per original
    // sale movement, restoring the same batches), cancels the sale's pick
    // list, and records who asked and who agreed. A voided credit sale stops
    // counting toward the customer's balance on its own. Runs inside
    // approveAs's transaction.
    private function voidSale(Request $request, VoidRequest $voidRequest, User $owner): void
    {
        $sale = Sale::whereKey($voidRequest->sale_id)->lockForUpdate()->firstOrFail();
        if ($sale->status !== 'completed') {
            throw ValidationException::withMessages(['void' => 'This sale is no longer a completed sale.']);
        }

        $sale->update(['status' => 'voided', 'voided_by' => $voidRequest->requested_by, 'void_reason' => $voidRequest->reason]);

        // Its pick list, if the items weren't picked up yet: don't hand them over.
        MaterialRequest::where('sale_id', $sale->id)->where('status', 'pending')->update(['status' => 'cancelled', 'updated_at' => now()]);

        foreach (StockMovement::where('reference_id', $sale->id)->where('reason', 'sale')->get() as $movement) {
            StockMovement::create([
                'product_id' => $movement->product_id,
                'batch_id' => $movement->batch_id,
                'terminal_id' => $movement->terminal_id,
                'delta' => abs($movement->delta),
                'reason' => 'void_restock',
                'reference_id' => $sale->id,
                'actor_id' => $owner->id,
                'client_created_at' => now(),
            ]);

            if ($movement->batch_id) {
                StockBatch::where('id', $movement->batch_id)->increment('qty_good_remaining', abs($movement->delta));
            }
        }

        AuditLog::create([
            'terminal_id' => $request->header('X-Terminal-Id', 'unknown'),
            'actor_id' => $voidRequest->requested_by,
            'approver_id' => $owner->id,
            'action_type' => 'admin_void',
            'entity_type' => 'sale',
            'entity_id' => $sale->id,
            'details' => [
                'reason' => $voidRequest->reason,
                'total_amount' => (string) $sale->total_amount,
                'approved_by' => $voidRequest->approvals()->pluck('user_id'),
            ],
            'client_created_at' => now(),
        ]);
    }

    private function present(VoidRequest $v): array
    {
        $open = $v->status === 'pending' && $v->expires_at->isFuture();
        $sale = $v->sale;

        return [
            'id' => $v->id,
            'status' => $v->status === 'pending' && ! $open ? 'expired' : $v->status,
            'reason' => $v->reason,
            // Counted on the server, so a device with a wrong clock still shows the right time left.
            'seconds_left' => $open ? (int) now()->diffInSeconds($v->expires_at, false) : 0,
            'approvals_needed' => VoidRequest::APPROVALS_NEEDED,
            'requested_by' => $v->requester?->only(['id', 'full_name']),
            'resolved_by' => $v->resolver?->only(['id', 'full_name']),
            'approvals' => $v->approvals->map(fn ($a) => ['user_id' => $a->user_id, 'full_name' => $a->user?->full_name])->values(),
            'sale' => [
                'id' => $sale->id,
                'status' => $sale->status,
                'total_amount' => $sale->total_amount,
                'payment_method' => $sale->payment_method,
                'client_created_at' => $sale->client_created_at?->toIso8601String(),
                'cashier' => $sale->cashier?->only(['id', 'full_name']),
                'customer' => $sale->customer?->only(['id', 'name']),
                'items' => $sale->items,
            ],
        ];
    }
}
