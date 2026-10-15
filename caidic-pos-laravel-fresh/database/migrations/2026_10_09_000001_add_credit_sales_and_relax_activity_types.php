<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

// Credit ("utang") sales and other payment methods, plus two fixes:
//  - activity_log.event_type was an enum of the 11 events the first version
//    logged. The app now logs many more (sale_completed, shift_started,
//    price_changed, ...), and every one of them was being rejected.
//  - Until the sync fix that ships with this migration, shifts were saved
//    under a server-made id instead of the terminal's, so the terminal's
//    sales could never attach to them. Those orphaned shifts are closed here
//    so they stop showing as "on shift". Nothing is deleted.
return new class extends Migration
{
    public function up(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_event_type_check');
            DB::statement('ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check');
            DB::statement("ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash', 'gcash', 'bank', 'credit', 'card', 'other'))");
        }

        Schema::create('customers', function (Blueprint $table) {
            $table->uuid('id')->primary(); // client-generated, so a credit sale works offline
            $table->string('name');
            $table->string('phone')->nullable();
            $table->boolean('is_active')->default(true);
            $table->timestamps();

            $table->index('name');
        });

        Schema::table('sales', function (Blueprint $table) {
            $table->foreignUuid('customer_id')->nullable()->constrained('customers');
            $table->decimal('amount_paid', 12, 2)->nullable(); // paid at the counter; on a credit sale the rest is owed
            $table->string('payment_reference')->nullable(); // GCash / bank reference number
        });

        Schema::create('credit_payments', function (Blueprint $table) {
            $table->uuid('id')->primary(); // client-generated
            $table->foreignUuid('customer_id')->constrained('customers');
            $table->decimal('amount', 12, 2);
            $table->string('payment_method'); // cash, gcash, bank
            $table->string('reference')->nullable();
            $table->string('note')->nullable();
            $table->string('terminal_id')->nullable();
            $table->foreignUuid('shift_id')->nullable()->constrained('shift_logs');
            $table->foreignUuid('received_by')->constrained('users');
            $table->timestampTz('client_created_at');
            $table->timestamps();

            $table->index(['customer_id', 'client_created_at']);
            $table->index('shift_id');
        });

        DB::table('shift_logs')
            ->where('status', 'open')
            ->where('started_at', '<', now()->subDay())
            ->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('sales')->whereColumn('sales.shift_id', 'shift_logs.id'))
            ->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('activity_log')->whereColumn('activity_log.shift_id', 'shift_logs.id'))
            ->update(['status' => 'closed', 'ended_at' => DB::raw('started_at')]);
    }

    public function down(): void
    {
        Schema::dropIfExists('credit_payments');

        Schema::table('sales', function (Blueprint $table) {
            $table->dropConstrainedForeignId('customer_id');
            $table->dropColumn(['amount_paid', 'payment_reference']);
        });

        Schema::dropIfExists('customers');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check');
            DB::statement("ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash', 'card', 'gcash', 'other'))");
            // The old activity_log enum isn't restored: rows logged since then would violate it.
        }
    }
};
