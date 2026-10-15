<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cycle_counts', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->date('business_date');
            $table->foreignUuid('product_id')->constrained('products');
            $table->enum('reason', ['top_mover', 'slow_mover', 'manual']);
            $table->decimal('system_quantity', 12, 3); // snapshot of what the system expected at count time
            $table->decimal('physical_quantity', 12, 3); // what the owner actually counted
            $table->decimal('variance', 12, 3);
            $table->foreignUuid('counted_by')->constrained('users');
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index(['business_date', 'product_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cycle_counts');
    }
};
