<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Laravel\Sanctum\HasApiTokens;

class User extends Model
{
    use HasUuid, HasApiTokens;

    protected $fillable = ['full_name', 'role', 'pin_hash', 'is_active'];

    protected $hidden = ['pin_hash'];

    protected $casts = [
        'is_active' => 'boolean',
        'locked_until' => 'datetime',
    ];

    public function isOwner(): bool
    {
        return $this->role === 'owner';
    }

    // manager and owner are treated as equals for the PIN-approval checkpoints
    // (void, no-sale) — NOT for returns, which stay owner-only. See SalesReturnPolicy.
    public function isManagerOrOwner(): bool
    {
        return in_array($this->role, ['manager', 'owner'], true);
    }
}
