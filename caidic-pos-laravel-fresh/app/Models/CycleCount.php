<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class CycleCount extends Model
{
    use HasUuid;

    protected $fillable = [
        'business_date', 'product_id', 'reason', 'system_quantity',
        'physical_quantity', 'variance', 'counted_by', 'client_created_at',
    ];

    protected $casts = [
        'business_date' => 'date',
        'client_created_at' => 'datetime',
        'system_quantity' => 'decimal:3',
        'physical_quantity' => 'decimal:3',
        'variance' => 'decimal:3',
    ];

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }
}
