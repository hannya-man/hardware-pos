<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use Laravel\Sanctum\HasApiTokens;

// Staff are cashiers (4-digit password) or owners (6 digits, two-factor
// login optional). Owners see and run everything; there is no manager role.
class User extends Model
{
    use HasUuid, HasApiTokens;

    private const MAX_PIN_ATTEMPTS = 5;
    private const LOCKOUT_MINUTES = 1;

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

    // Checks a typed password. Five wrong in a row lock the account for a
    // minute, then the count starts over. The counters aren't fillable, hence
    // forceFill.
    public function assertPin(string $pin): void
    {
        if ($this->locked_until && $this->locked_until->isFuture()) {
            throw ValidationException::withMessages(['pin' => 'Too many attempts — try again in a minute.']);
        }

        if (! Hash::check($pin, $this->pin_hash)) {
            $attempts = ($this->locked_until ? 0 : $this->failed_pin_attempts) + 1;
            $this->forceFill([
                'failed_pin_attempts' => $attempts,
                'locked_until' => $attempts >= self::MAX_PIN_ATTEMPTS ? now()->addMinutes(self::LOCKOUT_MINUTES) : null,
            ])->save();

            throw ValidationException::withMessages(['pin' => 'That password isn\'t right — try again.']);
        }

        if ($this->failed_pin_attempts || $this->locked_until) {
            $this->forceFill(['failed_pin_attempts' => 0, 'locked_until' => null])->save();
        }
    }
}
