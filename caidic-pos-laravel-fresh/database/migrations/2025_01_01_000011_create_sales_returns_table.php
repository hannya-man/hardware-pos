<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Named sales_returns, not returns — "return" collides with the PHP keyword
        // and reads badly as a bare table/model name anyway.
        Schema::create('sales_returns', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('original_sale_item_id')->nullable()->constrained('sale_items');
            $table->foreignUuid('product_id')->constrained('products');
            $table->decimal('quantity_returned', 12, 3);
            $table->enum('condition', ['good', 'damaged']);
            $table->foreignUuid('processed_by')->constrained('users'); // must be an owner — enforced in SalesReturnPolicy
            $table->string('reason')->nullable();
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index('product_id');
            $table->index('processed_by');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sales_returns');
    }
};
