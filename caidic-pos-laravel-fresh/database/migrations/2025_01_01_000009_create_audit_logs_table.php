<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('audit_logs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('terminal_id');
            $table->foreignUuid('actor_id')->nullable()->constrained('users'); // who triggered the event
            $table->foreignUuid('approver_id')->nullable()->constrained('users'); // manager/owner who approved, if any
            $table->enum('action_type', [
                'void_item', 'void_sale', 'admin_void', 'refund', 'price_override',
                'manual_stock_adjustment', 'failed_pin_attempt', 'shift_close_discrepancy',
                'return_accepted', 'damage_reported', 'stock_transfer',
                'cycle_count_correction', 'day_close_discrepancy',
                'batch_oversold', 'timestamp_anomaly_clamped',
            ]);
            $table->string('entity_type')->nullable();
            $table->uuid('entity_id')->nullable();
            $table->json('details')->nullable();
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index('actor_id');
            $table->index('client_created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_logs');
    }
};
