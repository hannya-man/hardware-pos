<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;

class DailyReconciliation extends Model
{
    use HasUuid;

    protected $fillable = [
        'business_date', 'performed_by', 'system_qty_out', 'physical_qty_out',
        'system_qty_in', 'physical_qty_in', 'discrepancy_out', 'discrepancy_in',
        'notes', 'status', 'client_created_at',
    ];

    protected $casts = [
        'business_date' => 'date',
        'client_created_at' => 'datetime',
        'system_qty_out' => 'decimal:3',
        'physical_qty_out' => 'decimal:3',
        'system_qty_in' => 'decimal:3',
        'physical_qty_in' => 'decimal:3',
        'discrepancy_out' => 'decimal:3',
        'discrepancy_in' => 'decimal:3',
    ];
}
