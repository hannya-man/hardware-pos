<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Sale extends Model
{
    use HasUuid;

    protected $fillable = [
        'terminal_id', 'cashier_id', 'shift_id', 'subtotal', 'discount_amount',
        'tax_amount', 'total_amount', 'payment_method', 'amount_tendered',
        'change_amount', 'status', 'voided_by', 'void_reason', 'client_created_at',
    ];

    protected $casts = [
        'client_created_at' => 'datetime',
        'subtotal' => 'decimal:2',
        'discount_amount' => 'decimal:2',
        'tax_amount' => 'decimal:2',
        'total_amount' => 'decimal:2',
        'amount_tendered' => 'decimal:2',
        'change_amount' => 'decimal:2',
    ];

    public function items(): HasMany
    {
        return $this->hasMany(SaleItem::class);
    }

    public function cashier(): BelongsTo
    {
        return $this->belongsTo(User::class, 'cashier_id');
    }

    public function shift(): BelongsTo
    {
        return $this->belongsTo(ShiftLog::class, 'shift_id');
    }
}
