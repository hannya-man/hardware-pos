<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('daily_reconciliations', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->date('business_date');
            $table->foreignUuid('performed_by')->constrained('users');
            $table->decimal('system_qty_out', 12, 3); // sales + deliveries, from stock_movements
            $table->decimal('physical_qty_out', 12, 3); // receipts/slips counted by hand
            $table->decimal('system_qty_in', 12, 3); // receiving + accepted returns
            $table->decimal('physical_qty_in', 12, 3);
            $table->decimal('discrepancy_out', 12, 3); // physical - system, out side
            $table->decimal('discrepancy_in', 12, 3);
            $table->string('notes')->nullable();
            $table->enum('status', ['matched', 'discrepancy_acknowledged'])->default('matched');
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->unique('business_date'); // one reconciliation per calendar day, storewide
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('daily_reconciliations');
    }
};
