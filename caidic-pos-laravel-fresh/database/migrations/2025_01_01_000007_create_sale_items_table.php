<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sale_items', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('sale_id')->constrained('sales');
            $table->foreignUuid('product_id')->constrained('products');
            $table->string('sku_snapshot');
            $table->string('name_snapshot');
            $table->decimal('unit_price_snapshot', 12, 2);
            $table->decimal('quantity', 12, 3);
            $table->decimal('line_discount', 12, 2)->default(0);
            $table->decimal('line_total', 12, 2);
            $table->timestampTz('voided_at')->nullable(); // set only by the authorized, audited void flow
            $table->foreignUuid('voided_by')->nullable()->constrained('users');
            $table->timestamps();

            $table->index('sale_id');
            $table->index('product_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sale_items');
    }
};
