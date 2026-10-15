<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\CreditPayment;
use App\Models\Customer;
use App\Models\Sale;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

// Credit ("utang"). Customers and payments are created at the register and
// arrive through /sync/push; these endpoints only read balances and history.
class CustomerController extends Controller
{
    // GET /customers?q=juan — everyone with a credit history, biggest balance first.
    public function index(Request $request)
    {
        Gate::authorize('use-credit');

        $customers = Customer::query()
            ->select('customers.*')
            ->withBalance()
            ->where('is_active', true)
            ->when($request->q, fn ($q, $term) => $q->where(fn ($w) => $w
                ->where('name', 'ilike', "%{$term}%")
                ->orWhere('phone', 'ilike', "%{$term}%")))
            ->get()
            ->map(fn ($c) => [
                'id' => $c->id, 'name' => $c->name, 'phone' => $c->phone,
                'owed' => $c->owed, 'last_activity_at' => $c->last_activity_at,
            ])
            ->sortBy([['owed', 'desc'], ['name', 'asc']])
            ->values();

        return response()->json([
            'customers' => $customers,
            'total_owed' => round($customers->sum('owed'), 2),
        ]);
    }

    // GET /customers/{id} — the balance and everything behind it.
    public function show(string $id)
    {
        Gate::authorize('use-credit');

        $customer = Customer::query()->select('customers.*')->withBalance()->findOrFail($id);

        $sales = Sale::with(['items:id,sale_id,name_snapshot,quantity,line_total', 'cashier:id,full_name'])
            ->where('customer_id', $id)
            ->latest('client_created_at')
            ->get(['id', 'cashier_id', 'total_amount', 'amount_paid', 'payment_method', 'status', 'client_created_at']);

        $payments = CreditPayment::with('receivedBy:id,full_name')
            ->where('customer_id', $id)
            ->latest('client_created_at')
            ->get();

        return response()->json([
            'customer' => ['id' => $customer->id, 'name' => $customer->name, 'phone' => $customer->phone, 'owed' => $customer->owed],
            'sales' => $sales,
            'payments' => $payments,
        ]);
    }
}
