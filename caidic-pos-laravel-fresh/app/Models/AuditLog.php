<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;

class AuditLog extends Model
{
    use HasUuid;

    protected $fillable = [
        'terminal_id', 'actor_id', 'approver_id', 'action_type',
        'entity_type', 'entity_id', 'details', 'client_created_at',
    ];

    protected $casts = [
        'client_created_at' => 'datetime',
        'details' => 'array',
    ];

    protected static function booted(): void
    {
        // Never use hard deletes for critical data, and never allow an edit
        // to a historical event — the same append-only rule schema.sql
        // enforced with a Postgres trigger, now enforced here instead since
        // Eloquent doesn't route saves through the database's own triggers
        // in a way the app can rely on across drivers.
        static::updating(fn () => throw new \RuntimeException('audit_logs is append-only — updates are not allowed'));
        static::deleting(fn () => throw new \RuntimeException('audit_logs is append-only — deletes are not allowed'));
    }
}
