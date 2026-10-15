<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sales', function (Blueprint $table) {
            $table->uuid('id')->primary(); // client-generated UUIDv4
            $table->string('terminal_id');
            $table->foreignUuid('cashier_id')->constrained('users');
            $table->foreignUuid('shift_id')->nullable()->constrained('shift_logs');
            $table->decimal('subtotal', 12, 2);
            $table->decimal('discount_amount', 12, 2)->default(0);
            $table->decimal('tax_amount', 12, 2)->default(0);
            $table->decimal('total_amount', 12, 2);
            $table->enum('payment_method', ['cash', 'card', 'gcash', 'other'])->default('cash');
            $table->decimal('amount_tendered', 12, 2)->nullable();
            $table->decimal('change_amount', 12, 2)->nullable();
            $table->enum('status', ['completed', 'voided', 'refunded'])->default('completed');
            $table->foreignUuid('voided_by')->nullable()->constrained('users');
            $table->string('void_reason')->nullable();
            $table->timestampTz('client_created_at'); // the real sale time — use this for shift-window queries, not created_at
            $table->timestamps();

            $table->index('client_created_at');
            $table->index('shift_id');
            $table->index('cashier_id');
            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sales');
    }
};
