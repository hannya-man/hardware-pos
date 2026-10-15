<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

// Money a credit customer paid back. Like the logs, it's append-only: a
// mistake is fixed with another entry, never by editing history.
class CreditPayment extends Model
{
    use HasUuid;

    protected $fillable = [
        'customer_id', 'amount', 'payment_method', 'reference', 'note',
        'terminal_id', 'shift_id', 'received_by', 'client_created_at',
    ];

    protected $casts = [
        'amount' => 'decimal:2',
        'client_created_at' => 'datetime',
    ];

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    public function receivedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'received_by');
    }

    protected static function booted(): void
    {
        static::updating(fn () => throw new \RuntimeException('credit_payments is append-only — updates are not allowed'));
        static::deleting(fn () => throw new \RuntimeException('credit_payments is append-only — deletes are not allowed'));
    }
}
