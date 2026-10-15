<?php

use App\Http\Controllers\Api\ActivityLogController;
use App\Http\Controllers\Api\AnalyticsController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CatalogController;
use App\Http\Controllers\Api\CategoryController;
use App\Http\Controllers\Api\CustomerController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\InventoryController;
use App\Http\Controllers\Api\MaterialRequestController;
use App\Http\Controllers\Api\ProductController;
use App\Http\Controllers\Api\ReconciliationController;
use App\Http\Controllers\Api\SalesController;
use App\Http\Controllers\Api\SalesReturnController;
use App\Http\Controllers\Api\ShiftController;
use App\Http\Controllers\Api\SyncController;
use App\Http\Controllers\Api\TwoFactorController;
use App\Http\Controllers\Api\UserController;
use App\Http\Controllers\Api\VoidRequestController;
use Illuminate\Support\Facades\Route;

// Routine terminal traffic — a device credential, not a person's login.
// Sales, shifts, customers, payments and logs all arrive through /sync/push.
Route::middleware('terminal.key')->group(function () {
    Route::get('/catalog', [CatalogController::class, 'index']);
    Route::post('/sync/push', [SyncController::class, 'push']);
});

// PIN -> Sanctum token, fetched on demand by screens that read the server.
Route::post('/auth/login', [AuthController::class, 'login']);

Route::middleware('auth:sanctum')->group(function () {
    Route::post('/auth/logout', [AuthController::class, 'logout']);

    Route::get('/dashboard', [DashboardController::class, 'summary']);

    // Items. next-sku must stay above {id}, or "next-sku" would be read as an id.
    Route::post('/products', [ProductController::class, 'store']);
    Route::get('/products/next-sku', [ProductController::class, 'nextSku']);
    Route::get('/products/{id}', [ProductController::class, 'show']);
    Route::patch('/products/{id}', [ProductController::class, 'update']);
    Route::get('/categories', [CategoryController::class, 'index']);
    Route::get('/inventory/stock', [InventoryController::class, 'stock']);

    Route::get('/sales', [SalesController::class, 'index']);
    Route::get('/shifts', [ShiftController::class, 'index']);
    Route::get('/shifts/{id}', [ShiftController::class, 'show']);
    Route::post('/returns', [SalesReturnController::class, 'store']);

    // Voids: two owners have to say yes within 10 minutes.
    Route::post('/sales/{id}/void-request', [VoidRequestController::class, 'store']);
    Route::get('/void-requests', [VoidRequestController::class, 'index']);
    Route::get('/void-requests/{id}', [VoidRequestController::class, 'show']);
    Route::post('/void-requests/{id}/approve', [VoidRequestController::class, 'approve']);
    Route::post('/void-requests/{id}/approve-here', [VoidRequestController::class, 'approveHere']);
    Route::post('/void-requests/{id}/reject', [VoidRequestController::class, 'reject']);

    Route::get('/customers', [CustomerController::class, 'index']);
    Route::get('/customers/{id}', [CustomerController::class, 'show']);

    // Pick lists are created offline and arrive through /sync/push.
    Route::get('/material-requests', [MaterialRequestController::class, 'index']);
    Route::patch('/material-requests/{id}/fulfill', [MaterialRequestController::class, 'fulfill']);

    Route::get('/users', [UserController::class, 'index']);
    Route::post('/users', [UserController::class, 'store']);
    Route::patch('/users/{id}', [UserController::class, 'update']);
    Route::post('/users/{id}/2fa/setup', [TwoFactorController::class, 'setup']);
    Route::post('/users/{id}/2fa/verify', [TwoFactorController::class, 'verify']);
    Route::post('/users/{id}/2fa/disable', [TwoFactorController::class, 'disable']);

    Route::get('/activity', [ActivityLogController::class, 'index']);

    // Not on a screen right now (daily stock audit, fast/slow movers with
    // cycle counts); kept so they can come back without backend work.
    Route::get('/reconciliation/today', [ReconciliationController::class, 'today']);
    Route::post('/reconciliation', [ReconciliationController::class, 'store']);
    Route::get('/analytics/movers', [AnalyticsController::class, 'movers']);
    Route::post('/cycle-counts', [AnalyticsController::class, 'storeCycleCount']);
});
