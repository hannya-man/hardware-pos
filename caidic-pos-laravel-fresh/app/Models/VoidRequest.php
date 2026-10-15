<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\DB;

// A void waiting for owners to agree. The sale is voided once two different
// owners have said yes (asking counts as a yes when an owner asks), and the
// request lapses if that hasn't happened MINUTES after it was made.
class VoidRequest extends Model
{
    use HasUuid;

    public const MINUTES = 10;
    public const APPROVALS_NEEDED = 2;

    protected $fillable = ['sale_id', 'requested_by', 'reason', 'status', 'expires_at', 'resolved_by', 'resolved_at'];

    protected $casts = [
        'expires_at' => 'datetime',
        'resolved_at' => 'datetime',
    ];

    public function sale(): BelongsTo
    {
        return $this->belongsTo(Sale::class);
    }

    public function requester(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requested_by');
    }

    public function resolver(): BelongsTo
    {
        return $this->belongsTo(User::class, 'resolved_by');
    }

    public function approvals(): HasMany
    {
        return $this->hasMany(VoidRequestApproval::class);
    }

    // Requests are marked expired the next time anyone looks, so nothing has
    // to run on a timer. Until then an overdue one already counts as lapsed.
    public static function expireOverdue(): void
    {
        static::where('status', 'pending')
            ->where('expires_at', '<=', now())
            ->update(['status' => 'expired', 'resolved_at' => DB::raw('expires_at'), 'updated_at' => now()]);
    }
}
