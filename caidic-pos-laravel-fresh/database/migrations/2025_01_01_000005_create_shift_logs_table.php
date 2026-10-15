<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shift_logs', function (Blueprint $table) {
            $table->uuid('id')->primary(); // client-generated
            $table->string('terminal_id');
            $table->foreignUuid('cashier_id')->constrained('users');
            $table->timestampTz('started_at');
            $table->timestampTz('ended_at')->nullable();
            $table->decimal('opening_cash', 12, 2)->default(0);
            $table->decimal('expected_cash', 12, 2)->nullable(); // withheld from the cashier until they submit their count
            $table->decimal('counted_cash', 12, 2)->nullable(); // the cashier's BLIND count
            $table->decimal('cash_discrepancy', 12, 2)->nullable();
            $table->enum('status', ['open', 'closed'])->default('open');
            $table->timestamps();

            $table->index('cashier_id');
            $table->index('started_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('shift_logs');
    }
};
