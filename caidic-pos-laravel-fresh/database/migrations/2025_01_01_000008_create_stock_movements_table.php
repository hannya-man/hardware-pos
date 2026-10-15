<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('stock_movements', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('product_id')->constrained('products');
            $table->foreignUuid('batch_id')->nullable()->constrained('stock_batches'); // which batch this delta applied to
            $table->string('terminal_id')->nullable(); // null = made from the admin app, not a terminal
            $table->decimal('delta', 12, 3); // negative = stock out, positive = stock in
            $table->enum('reason', [
                'sale', 'void_restock', 'manual_adjustment', 'stock_receipt',
                'stocktake_correction', 'transfer_out', 'transfer_in', 'damage',
            ]);
            $table->uuid('reference_id')->nullable(); // e.g. the sale_id this movement came from
            $table->foreignUuid('actor_id')->nullable()->constrained('users');
            $table->string('note')->nullable();
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index('product_id');
            $table->index('batch_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('stock_movements');
    }
};
