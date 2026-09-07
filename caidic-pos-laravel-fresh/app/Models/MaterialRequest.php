<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MaterialRequest extends Model
{
    use HasUuid;

    protected $fillable = [
        'terminal_id', 'requested_by', 'items', 'status', 'notes',
        'fulfilled_by', 'fulfilled_at', 'client_created_at',
    ];

    protected $casts = [
        'items' => 'array',
        'fulfilled_at' => 'datetime',
        'client_created_at' => 'datetime',
    ];

    public function requestedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requested_by');
    }

    public function fulfilledBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'fulfilled_by');
    }
}
