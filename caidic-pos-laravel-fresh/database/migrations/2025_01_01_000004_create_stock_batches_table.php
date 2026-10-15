<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('stock_batches', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('product_id')->constrained('products');
            $table->enum('location', ['store', 'warehouse']);
            $table->timestampTz('received_at'); // the FIFO order key — a transfer keeps the original value
            $table->decimal('qty_received', 12, 3);
            $table->decimal('qty_good_remaining', 12, 3);
            $table->decimal('qty_damaged', 12, 3)->default(0); // locked from sale, never decremented by a sale
            $table->enum('source', ['receiving', 'transfer_in', 'return_accepted', 'stocktake_correction']);
            $table->uuid('reference_id')->nullable(); // links back to the transfer/return/count that created this batch
            $table->foreignUuid('created_by')->nullable()->constrained('users');
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index(['product_id', 'location', 'received_at']); // the exact lookup completeSale() runs for FIFO
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('stock_batches');
    }
};
