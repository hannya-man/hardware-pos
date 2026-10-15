<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

// Someone who buys on credit ("utang"). Created at the register, offline.
class Customer extends Model
{
    use HasUuid;

    protected $fillable = ['name', 'phone', 'is_active'];

    protected $casts = ['is_active' => 'boolean'];

    public function sales(): HasMany
    {
        return $this->hasMany(Sale::class);
    }

    public function payments(): HasMany
    {
        return $this->hasMany(CreditPayment::class);
    }

    // Adds `owed`: what's still unpaid on completed credit sales, minus
    // everything paid back since. A voided sale drops out on its own.
    public function scopeWithBalance(Builder $query): Builder
    {
        return $query->addSelect([
            'credit_total' => Sale::selectRaw('coalesce(sum(total_amount - coalesce(amount_paid, 0)), 0)')
                ->whereColumn('customer_id', 'customers.id')
                ->where('payment_method', 'credit')
                ->where('status', 'completed'),
            'paid_total' => CreditPayment::selectRaw('coalesce(sum(amount), 0)')
                ->whereColumn('customer_id', 'customers.id'),
            'last_activity_at' => Sale::selectRaw('max(client_created_at)')
                ->whereColumn('customer_id', 'customers.id'),
        ]);
    }

    public function getOwedAttribute(): float
    {
        return round((float) ($this->credit_total ?? 0) - (float) ($this->paid_total ?? 0), 2);
    }
}
