<?php

namespace App\Providers;

use App\Models\User;
use Illuminate\Foundation\Support\Providers\AuthServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Gate;

class AuthServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // Void a paid sale, No Sale, admin-initiated void — manager and owner
        // are equals here, matching the existing PIN-approval behaviour.
        Gate::define('approve-void', fn (User $user) => $user->isManagerOrOwner());

        // Accepting a customer return — owner only. Not manager. This is the
        // one place the roles genuinely diverge, per the original request.
        Gate::define('process-return', fn (User $user) => $user->isOwner());

        // Signing off a day-close inventory mismatch — owner only.
        Gate::define('sign-off-reconciliation', fn (User $user) => $user->isOwner());

        // Fast/slow-mover dashboard and targeted cycle counts — owner only.
        Gate::define('view-analytics', fn (User $user) => $user->isOwner());

        // Staff accounts — manager and owner, matching the existing nav.
        Gate::define('manage-users', fn (User $user) => $user->isManagerOrOwner());

        // The per-cashier activity trail — owner only. Cashiers never see
        // this gate exists; there's no route that checks it any differently
        // for them than a 404 would.
        Gate::define('view-activity-log', fn (User $user) => $user->isOwner());

        // Dashboard summary cards — manager and owner, unlike the owner-only
        // Fast/Slow Movers page it sits next to.
        Gate::define('view-dashboard', fn (User $user) => $user->isManagerOrOwner());

        // Stock browsing, receiving, and archive/restore + price edits —
        // manager and owner. Never exposes cost_price.
        Gate::define('manage-catalog', fn (User $user) => $user->isManagerOrOwner());

        // Browsing sales/shifts and the Void screen's list — manager and
        // owner. Actually voiding a sale still goes through approve-void.
        Gate::define('view-sales', fn (User $user) => $user->isManagerOrOwner());
    }
}
