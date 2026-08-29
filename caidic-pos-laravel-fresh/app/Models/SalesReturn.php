<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class SalesReturn extends Model
{
    use HasUuid;

    protected $table = 'sales_returns';

    protected $fillable = [
        'original_sale_item_id', 'product_id', 'quantity_returned',
        'condition', 'processed_by', 'reason', 'client_created_at',
    ];

    protected $casts = [
        'client_created_at' => 'datetime',
        'quantity_returned' => 'decimal:3',
    ];

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    public function originalSaleItem(): BelongsTo
    {
        return $this->belongsTo(SaleItem::class, 'original_sale_item_id');
    }

    public function processedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'processed_by');
    }
}
