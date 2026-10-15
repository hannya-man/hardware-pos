<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('terminals', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('name'); // e.g. "Front counter", "Terminal 2" — for the owner to recognize it in a list
            $table->string('api_key_hash'); // sha256, not bcrypt — this is a long random secret, not a guessable 4-digit PIN, so it doesn't need bcrypt's deliberate slowness on every single sync request
            $table->boolean('is_active')->default(true);
            $table->timestampTz('last_seen_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('terminals');
    }
};
