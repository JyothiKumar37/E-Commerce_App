import { Link, useNavigate } from "react-router-dom";
import { useCart, useRemoveCartItem, useUpdateCartItem } from "@/hooks/queries";
import { useAuth } from "@/store/auth";
import { useToast } from "@/store/toast";
import { ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { Alert, Button, Card, EmptyState, PageSpinner, Select } from "@/components/ui";

export function CartPage() {
  const { user, initialising } = useAuth();
  const navigate = useNavigate();
  const { notify } = useToast();

  const { data: cart, isLoading } = useCart(Boolean(user));
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();

  if (initialising) return <PageSpinner />;

  if (!user) {
    return (
      <EmptyState
        icon="🔐"
        title="Sign in to see your cart"
        description="Your cart is saved to your account, so it follows you between devices."
        action={
          <Link to="/signin?next=/cart">
            <Button>Sign in</Button>
          </Link>
        }
      />
    );
  }

  if (isLoading) return <PageSpinner label="Loading cart" />;

  if (!cart || cart.items.length === 0) {
    return (
      <EmptyState
        icon="🛒"
        title="Your cart is empty"
        description="Browse the catalog and add something you like."
        action={
          <Link to="/search">
            <Button>Start shopping</Button>
          </Link>
        }
      />
    );
  }

  const freeShippingGap = 5000 - cart.subtotalCents;

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold tracking-tight">Your cart</h1>

      {/* Items dropped or clamped server-side are reported, never silently
          removed — the customer needs to know before they reach payment. */}
      {cart.unavailable.length > 0 && (
        <div className="mb-6">
          <Alert kind="warning">
            <p className="font-medium">Some items are no longer available</p>
            <ul className="mt-1 list-inside list-disc">
              {cart.unavailable.map((item) => (
                <li key={item.productId}>
                  {item.name ?? "An item"} —{" "}
                  {item.reason === "out_of_stock" ? "out of stock" : "no longer sold"}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {cart.items.some((item) => item.quantityAdjusted) && (
        <div className="mb-6">
          <Alert kind="warning">
            We reduced some quantities to match the stock currently available.
          </Alert>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <ul className="space-y-4">
          {cart.items.map((item) => (
            <li key={item.productId}>
              <Card className="flex gap-4 p-4">
                <Link
                  to={`/products/${item.productId}`}
                  className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800"
                >
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-2xl" aria-hidden="true">
                      📦
                    </div>
                  )}
                </Link>

                <div className="flex flex-1 flex-col gap-1">
                  <Link
                    to={`/products/${item.productId}`}
                    className="font-medium leading-snug transition hover:text-brand-600"
                  >
                    {item.name}
                  </Link>
                  <p className="text-xs text-slate-500 dark:text-slate-400">SKU {item.sku}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {formatMoney(item.unitPriceCents, item.currency)} each
                  </p>

                  <div className="mt-auto flex items-center gap-3 pt-2">
                    <label htmlFor={`qty-${item.productId}`} className="sr-only">
                      Quantity for {item.name}
                    </label>
                    <Select
                      id={`qty-${item.productId}`}
                      value={item.quantity}
                      disabled={updateItem.isPending}
                      onChange={(e) =>
                        updateItem.mutate(
                          { productId: item.productId, quantity: Number(e.target.value) },
                          {
                            onError: (err) =>
                              notify(
                                err instanceof ApiError
                                  ? err.message
                                  : "Could not update quantity.",
                                "error",
                              ),
                          },
                        )
                      }
                      className="w-20"
                    >
                      {Array.from({ length: Math.min(item.available, 20) }, (_, i) => i + 1).map(
                        (n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ),
                      )}
                    </Select>

                    <button
                      type="button"
                      onClick={() =>
                        removeItem.mutate(item.productId, {
                          onSuccess: () => notify("Item removed.", "success"),
                        })
                      }
                      disabled={removeItem.isPending}
                      className="text-sm text-red-600 transition hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <p className="shrink-0 font-semibold">
                  {formatMoney(item.lineTotalCents, item.currency)}
                </p>
              </Card>
            </li>
          ))}
        </ul>

        {/* ---------------------------- summary --------------------------- */}
        <aside>
          <Card className="sticky top-24 space-y-4 p-6">
            <h2 className="font-semibold">Order summary</h2>

            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600 dark:text-slate-400">Subtotal</dt>
                <dd>{formatMoney(cart.subtotalCents, cart.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600 dark:text-slate-400">Shipping</dt>
                <dd>
                  {cart.shippingCents === 0 ? (
                    <span className="text-emerald-600">Free</span>
                  ) : (
                    formatMoney(cart.shippingCents, cart.currency)
                  )}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600 dark:text-slate-400">VAT (19%)</dt>
                <dd>{formatMoney(cart.taxCents, cart.currency)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold dark:border-slate-700">
                <dt>Total</dt>
                <dd>{formatMoney(cart.totalCents, cart.currency)}</dd>
              </div>
            </dl>

            {freeShippingGap > 0 && (
              <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:bg-brand-950/50 dark:text-brand-200">
                Add {formatMoney(freeShippingGap, cart.currency)} more for free shipping.
              </p>
            )}

            <Button
              fullWidth
              size="lg"
              onClick={() => navigate("/checkout")}
              disabled={cart.items.length === 0}
            >
              Proceed to checkout
            </Button>

            <Link
              to="/search"
              className="block text-center text-sm text-brand-600 transition hover:underline"
            >
              Continue shopping
            </Link>
          </Card>
        </aside>
      </div>
    </div>
  );
}
