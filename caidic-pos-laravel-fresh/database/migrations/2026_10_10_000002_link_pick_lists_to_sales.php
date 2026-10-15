<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Every sale now sends its items to the pick lists, so the stockroom can get
// them ready. sale_id ties a list to its sale (and the slip's Ref no.). No
// foreign key: a list must still reach the stockroom if its sale is slow to
// sync. Status gains "cancelled", for a list whose sale was voided.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('material_requests', function (Blueprint $table) {
            $table->uuid('sale_id')->nullable()->after('terminal_id');
            $table->index('sale_id');
        });
    }

    public function down(): void
    {
        Schema::table('material_requests', function (Blueprint $table) {
            $table->dropIndex(['sale_id']);
            $table->dropColumn('sale_id');
        });
    }
};
