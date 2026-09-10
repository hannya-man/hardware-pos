<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ActivityLog extends Model
{
    use HasUuid;

    protected $table = 'activity_log';

    protected $fillable = [
        'terminal_id', 'actor_id', 'shift_id', 'event_type',
        'entity_type', 'entity_id', 'details', 'client_created_at',
    ];

    protected $casts = [
        'client_created_at' => 'datetime',
        'details' => 'array',
    ];

    // Lets Staff Logs show the actual staff member's name instead of a
    // raw id. Nothing was resolving actor_id to a person before this.
    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_id');
    }

    protected static function booted(): void
    {
        static::updating(fn () => throw new \RuntimeException('activity_log is append-only — updates are not allowed'));
        static::deleting(fn () => throw new \RuntimeException('activity_log is append-only — deletes are not allowed'));
    }
}
