<?php

namespace App\Providers;

use App\Models\User;
use Illuminate\Foundation\Support\Providers\AuthServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Gate;

// Two roles: cashiers sell, take credit payments, and send pick lists; owners
// do everything. The gates stay separate so each endpoint says what it is.
class AuthServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // Asking for and agreeing to a void. A void only goes through once
        // two different owners have said yes (see VoidRequestController).
        Gate::define('approve-void', fn (User $user) => $user->isOwner());

        Gate::define('process-return', fn (User $user) => $user->isOwner());
        Gate::define('sign-off-reconciliation', fn (User $user) => $user->isOwner());
        Gate::define('view-analytics', fn (User $user) => $user->isOwner());
        Gate::define('manage-users', fn (User $user) => $user->isOwner());
        Gate::define('view-activity-log', fn (User $user) => $user->isOwner());
        Gate::define('view-dashboard', fn (User $user) => $user->isOwner());

        // Stock, prices, deliveries, and pick lists. Never exposes cost_price.
        Gate::define('manage-catalog', fn (User $user) => $user->isOwner());

        // Sales and shifts.
        Gate::define('view-sales', fn (User $user) => $user->isOwner());

        // Credit ("utang") balances — everyone, since a cashier is the one
        // who takes a customer's payment at the counter.
        Gate::define('use-credit', fn (User $user) => $user->is_active);

        // Pick lists — everyone: whoever works the stockroom gets the items
        // ready and marks them picked up.
        Gate::define('use-pick-lists', fn (User $user) => $user->is_active);
    }
}
