<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('sku')->unique();
            $table->string('barcode')->nullable()->unique();
            $table->string('name');
            $table->foreignUuid('category_id')->constrained('categories');
            $table->string('unit'); // pc, kg, bag, m, sheet, box...
            $table->decimal('unit_price', 12, 2);
            $table->decimal('cost_price', 12, 2)->nullable(); // never synced to cashier terminals — see CatalogController
            $table->decimal('reorder_level', 12, 3)->default(0);
            $table->boolean('is_active')->default(true);
            $table->timestamps();

            $table->index('name');
            $table->index('updated_at'); // lets terminals pull only what changed since last sync
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('products');
    }
};
