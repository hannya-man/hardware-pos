<?php

use App\Http\Controllers\Api\ActivityLogController;
use App\Http\Controllers\Api\AnalyticsController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CatalogController;
use App\Http\Controllers\Api\ProductController;
use App\Http\Controllers\Api\ReconciliationController;
use App\Http\Controllers\Api\SalesReturnController;
use App\Http\Controllers\Api\SyncController;
use Illuminate\Support\Facades\Route;

// Routine terminal traffic — a device credential, not a person's login.
// Works whether or not anyone happens to be authenticated with the server
// right now; the terminal only needs to have been provisioned once.
Route::middleware('terminal.key')->group(function () {
    Route::get('/catalog', [CatalogController::class, 'index']);
    Route::post('/sync/push', [SyncController::class, 'push']);
});

// PIN -> Sanctum token exchange. Called on demand, right before an
// owner-gated action -- never required just to start using the till.
Route::post('/auth/login', [AuthController::class, 'login']);

Route::middleware('auth:sanctum')->group(function () {
    Route::post('/auth/logout', [AuthController::class, 'logout']);

    Route::post('/returns', [SalesReturnController::class, 'store']);
    Route::get('/products/{id}', [ProductController::class, 'show']);

    Route::get('/reconciliation/today', [ReconciliationController::class, 'today']);
    Route::post('/reconciliation', [ReconciliationController::class, 'store']);

    Route::get('/analytics/movers', [AnalyticsController::class, 'movers']);
    Route::post('/cycle-counts', [AnalyticsController::class, 'storeCycleCount']);

    Route::get('/activity', [ActivityLogController::class, 'index']);
});

// activity_log writes (a cashier's own routine actions) travel with the
// rest of routine sync traffic, not a live per-user session -- see
// SyncController, entity_type: 'activity_log'. Nothing extra needed here.
