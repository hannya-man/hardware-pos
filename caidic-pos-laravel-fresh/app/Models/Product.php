<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Product extends Model
{
    use HasUuid;

    protected $fillable = [
        'sku', 'barcode', 'name', 'category_id', 'unit',
        'unit_price', 'cost_price', 'reorder_level', 'is_active',
    ];

    protected $casts = [
        'unit_price' => 'decimal:2',
        'cost_price' => 'decimal:2',
        'reorder_level' => 'decimal:3',
        'is_active' => 'boolean',
    ];

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class);
    }

    public function batches(): HasMany
    {
        return $this->hasMany(StockBatch::class);
    }

    // Sellable quantity at a location — sum of qty_good_remaining across open
    // batches. This is the ONLY number checkout is ever allowed to offer;
    // qty_damaged never enters this total. See stock-batches note in README.
    public function goodStockAt(string $location): float
    {
        return (float) $this->batches()
            ->where('location', $location)
            ->where('qty_good_remaining', '>', 0)
            ->sum('qty_good_remaining');
    }

    public function damagedStockTotal(): float
    {
        return (float) $this->batches()->sum('qty_damaged');
    }
}
