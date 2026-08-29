<?php

use App\Http\Middleware\AuthenticateTerminal;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up', // this is what sync-worker.js's checkRealConnectivity() pings
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->alias(['terminal.key' => AuthenticateTerminal::class]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        //
    })->create();
