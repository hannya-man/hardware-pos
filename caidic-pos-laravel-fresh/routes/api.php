<?php

use App\Http\Controllers\Api\ActivityLogController;
use App\Http\Controllers\Api\AnalyticsController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CatalogController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\InventoryController;
use App\Http\Controllers\Api\MaterialRequestController;
use App\Http\Controllers\Api\ProductController;
use App\Http\Controllers\Api\PurchaseOrderController;
use App\Http\Controllers\Api\ReconciliationController;
use App\Http\Controllers\Api\SalesController;
use App\Http\Controllers\Api\SalesReturnController;
use App\Http\Controllers\Api\ShiftController;
use App\Http\Controllers\Api\SupplierController;
use App\Http\Controllers\Api\SyncController;
use App\Http\Controllers\Api\UserController;
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
    Route::patch('/products/{id}', [ProductController::class, 'update']);

    Route::get('/reconciliation/today', [ReconciliationController::class, 'today']);
    Route::post('/reconciliation', [ReconciliationController::class, 'store']);

    Route::get('/analytics/movers', [AnalyticsController::class, 'movers']);
    Route::post('/cycle-counts', [AnalyticsController::class, 'storeCycleCount']);

    Route::get('/activity', [ActivityLogController::class, 'index']);

    Route::get('/users', [UserController::class, 'index']);
    Route::post('/users', [UserController::class, 'store']);
    Route::patch('/users/{id}', [UserController::class, 'update']);

    Route::get('/dashboard', [DashboardController::class, 'summary']);

    Route::get('/inventory/stock', [InventoryController::class, 'stock']);

    Route::get('/sales', [SalesController::class, 'index']);
    Route::post('/sales/{id}/void', [SalesController::class, 'void']);
    Route::get('/shifts', [ShiftController::class, 'index']);

    // Material Pick Lists — view/fulfill only. Creation happens offline
    // from POS Terminal and arrives through /sync/push, not here.
    Route::get('/material-requests', [MaterialRequestController::class, 'index']);
    Route::patch('/material-requests/{id}/fulfill', [MaterialRequestController::class, 'fulfill']);

    // Supplier Orders
    Route::get('/suppliers', [SupplierController::class, 'index']);
    Route::post('/suppliers', [SupplierController::class, 'store']);
    Route::get('/purchase-orders', [PurchaseOrderController::class, 'index']);
    Route::post('/purchase-orders', [PurchaseOrderController::class, 'store']);
    Route::patch('/purchase-orders/{id}/receive', [PurchaseOrderController::class, 'receive']);
});

// activity_log writes (a cashier's own routine actions) travel with the
// rest of routine sync traffic, not a live per-user session -- see
// SyncController, entity_type: 'activity_log'. Nothing extra needed here.
