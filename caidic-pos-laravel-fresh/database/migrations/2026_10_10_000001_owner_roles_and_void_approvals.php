<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

// Two changes:
//  - The store has no managers: staff are cashiers or owners. A manager
//    account left over becomes a cashier (the lesser access, and the same
//    4-digit password length); an owner can promote it from Staff.
//  - A void needs two owners to say yes within 10 minutes. Each request and
//    every yes is kept, so the history shows who agreed to what.
return new class extends Migration
{
    public function up(): void
    {
        DB::table('users')->where('role', 'manager')->update(['role' => 'cashier', 'updated_at' => now()]);

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
            DB::statement("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('cashier', 'owner'))");
        }

        Schema::create('void_requests', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('sale_id')->constrained('sales');
            $table->foreignUuid('requested_by')->constrained('users');
            $table->string('reason');
            $table->string('status')->default('pending'); // pending, approved, rejected, cancelled, expired
            $table->timestampTz('expires_at');
            $table->foreignUuid('resolved_by')->nullable()->constrained('users'); // who turned it down or cancelled it
            $table->timestampTz('resolved_at')->nullable();
            $table->timestamps();

            $table->index(['status', 'expires_at']);
        });

        Schema::create('void_request_approvals', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('void_request_id')->constrained('void_requests')->cascadeOnDelete();
            $table->foreignUuid('user_id')->constrained('users');
            $table->timestamps();

            $table->unique(['void_request_id', 'user_id']); // one yes per owner
        });

        // At most one open request per sale, even if two owners ask at once.
        if (DB::getDriverName() === 'pgsql') {
            DB::statement("CREATE UNIQUE INDEX void_requests_one_pending_per_sale ON void_requests (sale_id) WHERE status = 'pending'");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('void_request_approvals');
        Schema::dropIfExists('void_requests');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
            DB::statement("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'manager', 'cashier'))");
        }
    }
};
