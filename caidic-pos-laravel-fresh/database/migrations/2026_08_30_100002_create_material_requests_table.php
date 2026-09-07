<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('material_requests', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('terminal_id')->nullable();
            $table->uuid('requested_by');
            $table->json('items'); // [{product_id, sku_snapshot, name_snapshot, quantity_requested}]
            $table->string('status')->default('pending'); // pending, fulfilled
            $table->text('notes')->nullable();
            $table->uuid('fulfilled_by')->nullable();
            $table->timestamp('fulfilled_at')->nullable();
            $table->timestamp('client_created_at');
            $table->timestamps();

            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('material_requests');
    }
};
