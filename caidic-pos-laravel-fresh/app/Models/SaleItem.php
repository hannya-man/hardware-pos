<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class SaleItem extends Model
{
    use HasUuid;

    protected $fillable = [
        'sale_id', 'product_id', 'sku_snapshot', 'name_snapshot',
        'unit_price_snapshot', 'quantity', 'line_discount', 'line_total',
        'voided_at', 'voided_by',
    ];

    protected $casts = [
        'voided_at' => 'datetime',
        'unit_price_snapshot' => 'decimal:2',
        'quantity' => 'decimal:3',
        'line_discount' => 'decimal:2',
        'line_total' => 'decimal:2',
    ];

    public function sale(): BelongsTo
    {
        return $this->belongsTo(Sale::class);
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }
}
