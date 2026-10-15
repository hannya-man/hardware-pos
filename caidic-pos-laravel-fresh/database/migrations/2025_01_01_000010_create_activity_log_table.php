<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('activity_log', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('terminal_id');
            $table->foreignUuid('actor_id')->constrained('users');
            $table->foreignUuid('shift_id')->nullable()->constrained('shift_logs');
            $table->enum('event_type', [
                'login', 'logout', 'item_added', 'item_removed', 'quantity_changed',
                'order_cancelled', 'barcode_scanned', 'barcode_no_match',
                'search_performed', 'no_sale_requested', 'void_requested',
            ]);
            $table->string('entity_type')->nullable();
            $table->uuid('entity_id')->nullable();
            $table->json('details')->nullable();
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index(['actor_id', 'client_created_at']); // the exact lookup the owner's activity screen filters on
            $table->index('shift_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('activity_log');
    }
};
