<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class StockMovement extends Model
{
    use HasUuid;

    protected $fillable = [
        'product_id', 'batch_id', 'terminal_id', 'delta', 'reason',
        'reference_id', 'actor_id', 'note', 'client_created_at',
    ];

    protected $casts = [
        'client_created_at' => 'datetime',
        'delta' => 'decimal:3',
    ];

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    public function batch(): BelongsTo
    {
        return $this->belongsTo(StockBatch::class, 'batch_id');
    }
}
