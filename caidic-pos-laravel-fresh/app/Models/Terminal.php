<?php

namespace App\Models;

use App\Traits\HasUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

class Terminal extends Model
{
    use HasUuid;

    protected $fillable = ['name', 'api_key_hash', 'is_active'];
    protected $hidden = ['api_key_hash'];
    protected $casts = ['is_active' => 'boolean', 'last_seen_at' => 'datetime'];

    // Called once when an owner provisions a new physical device — the raw
    // key is shown ONCE (here, as the return value) and never stored or
    // recoverable again, same principle as any other API secret.
    public static function provision(string $name): array
    {
        $rawKey = Str::random(48);
        $terminal = self::create(['name' => $name, 'api_key_hash' => hash('sha256', $rawKey)]);

        return ['terminal' => $terminal, 'raw_key' => $rawKey];
    }

    public static function findByRawKey(string $rawKey): ?self
    {
        return self::where('api_key_hash', hash('sha256', $rawKey))
            ->where('is_active', true)
            ->first();
    }
}
