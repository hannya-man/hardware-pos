<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Laravel\Sanctum\HasApiTokens;

class User extends Model
{
    use HasUuid, HasApiTokens;

    protected $fillable = ['full_name', 'role', 'pin_hash', 'is_active', 'totp_secret', 'totp_enabled'];

    // totp_secret is exactly as sensitive as pin_hash and is hidden the
    // same way — CatalogController already has to call ->makeVisible()
    // to let pin_hash sync down to terminals for offline login; the same
    // call needs 'totp_secret' added to it too, or two-factor codes will
    // never verify correctly while offline. See PATCH_NOTES.md.
    protected $hidden = ['pin_hash', 'totp_secret'];

    protected $casts = [
        'is_active' => 'boolean',
        'locked_until' => 'datetime',
        'totp_enabled' => 'boolean',
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
