<?php

namespace Database\Seeders;

use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    use WithoutModelEvents;

    /**
     * Seed the application's database.
     *
     * The stock Laravel version of this file called User::factory() with
     * 'name'/'email' — fields that don't exist on this app's actual User
     * model (full_name, role, pin_hash). It would have thrown the moment
     * anyone ran `php artisan db:seed` without --class. Replaced with the
     * real catalog seed instead of leaving a call that just errors out.
     */
    public function run(): void
    {
        $this->call(ProductCatalogSeeder::class);
    }
}
