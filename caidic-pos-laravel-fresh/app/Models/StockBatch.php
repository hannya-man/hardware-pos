<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class StockBatch extends Model
{
    use HasUuid;

    protected $fillable = [
        'product_id', 'location', 'received_at', 'qty_received',
        'qty_good_remaining', 'qty_damaged', 'source', 'reference_id', 'created_by',
        'client_created_at',
    ];

    protected $casts = [
        'received_at' => 'datetime',
        'client_created_at' => 'datetime',
        'qty_received' => 'decimal:3',
        'qty_good_remaining' => 'decimal:3',
        'qty_damaged' => 'decimal:3',
    ];

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function movements(): HasMany
    {
        return $this->hasMany(StockMovement::class, 'batch_id');
    }
}
