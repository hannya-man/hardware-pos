<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('purchase_orders', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('supplier_id')->constrained('suppliers');
            $table->string('po_number')->unique();
            $table->string('status')->default('pending'); // pending, received, cancelled
            $table->json('items'); // [{product_id, sku_snapshot, name_snapshot, quantity_ordered, unit_cost}]
            $table->text('notes')->nullable();
            $table->foreignUuid('ordered_by')->nullable()->constrained('users');
            $table->date('expected_date')->nullable();
            $table->timestamp('received_at')->nullable();
            $table->timestamp('client_created_at');
            $table->timestamps();

            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('purchase_orders');
    }
};
