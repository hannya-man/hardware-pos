<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class PurchaseOrder extends Model
{
    use HasUuid;

    protected $fillable = [
        'supplier_id', 'po_number', 'status', 'items', 'notes',
        'ordered_by', 'expected_date', 'received_at', 'client_created_at',
    ];

    protected $casts = [
        'items' => 'array',
        'expected_date' => 'date',
        'received_at' => 'datetime',
        'client_created_at' => 'datetime',
    ];

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class);
    }

    public function orderedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'ordered_by');
    }
}
