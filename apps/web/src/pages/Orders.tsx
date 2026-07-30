import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useCancelOrder, useOrder, useOrders } from "@/hooks/queries";
import { useAuth } from "@/store/auth";
import { useToast } from "@/store/toast";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatMoney, humanise } from "@/lib/format";
import type { OrderStatus } from "@/lib/types";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageSpinner,
  Pagination,
} from "@/components/ui";

const STATUS_TONE: Record<OrderStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  pending_payment: "warning",
  paid: "info",
  processing: "info",
  shipped: "info",
  delivered: "success",
  cancelled: "neutral",
  refunded: "neutral",
  failed: "danger",
};

const CANCELLABLE: OrderStatus[] = ["pending_payment", "paid", "processing"];

export function OrdersPage() {
  const { user, initialising } = useAuth();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, refetch } = useOrders(
    { page, pageSize: 10 },
    Boolean(user),
  );

  if (initialising) return <PageSpinner />;

  if (!user) {
    return (
      <EmptyState
        icon="🔐"
        title="Sign in to see your orders"
        action={
          <Link to="/signin?next=/orders">
            <Button>Sign in</Button>
          </Link>
        }
      />
    );
  }

  if (isLoading) return <PageSpinner label="Loading orders" />;
  if (isError) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => refetch()}
      />
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <EmptyState
        icon="📦"
        title="No orders yet"
        description="When you place an order it will show up here."
        action={
          <Link to="/search">
            <Button>Start shopping</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold tracking-tight">Your orders</h1>

      <ul className="space-y-4">
        {data.items.map((order) => (
          <li key={order.orderId}>
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/orders/${order.orderId}`}
                      className="font-semibold transition hover:text-brand-600"
                    >
                      {order.orderNumber}
                    </Link>
                    <Badge tone={STATUS_TONE[order.status]}>{humanise(order.status)}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Placed {formatDateTime(order.placedAt)} · {order.itemCount}{" "}
                    {order.itemCount === 1 ? "item" : "items"}
                  </p>
                </div>

                <div className="text-right">
                  <p className="font-semibold">{formatMoney(order.totalCents, order.currency)}</p>
                  <Link
                    to={`/orders/${order.orderId}`}
                    className="text-sm text-brand-600 transition hover:underline"
                  >
                    View details →
                  </Link>
                </div>
              </div>

              {order.items.length > 0 && (
                <div className="mt-4 flex gap-2 overflow-x-auto">
                  {order.items.slice(0, 6).map((item, index) => (
                    <div
                      key={`${order.orderId}-${index}`}
                      className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800"
                      title={`${item.name} × ${item.quantity}`}
                    >
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full place-items-center text-lg" aria-hidden="true">
                          📦
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      <div className="mt-10">
        <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
      </div>
    </div>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [searchParams] = useSearchParams();
  const justPlaced = searchParams.get("placed") === "1";
  const { notify } = useToast();

  const { data: order, isLoading, isError, error, refetch } = useOrder(orderId);
  const cancelOrder = useCancelOrder();

  if (isLoading) return <PageSpinner label="Loading order" />;
  if (isError || !order) {
    return (
      <ErrorState
        title="Order not found"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => refetch()}
      />
    );
  }

  const canCancel = CANCELLABLE.includes(order.status);

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "Home", to: "/" },
          { label: "Orders", to: "/orders" },
          { label: order.orderNumber },
        ]}
      />

      {justPlaced && (
        <div className="mb-6">
          <Alert kind="success">
            <p className="font-medium">Thank you — your order is confirmed.</p>
            <p className="mt-0.5">
              We have emailed a receipt. You can track progress on this page.
            </p>
          </Alert>
        </div>
      )}

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{order.orderNumber}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Placed {formatDateTime(order.placedAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={STATUS_TONE[order.status]}>{humanise(order.status)}</Badge>
          {canCancel && (
            <Button
              variant="secondary"
              size="sm"
              loading={cancelOrder.isPending}
              onClick={() => {
                if (!window.confirm("Cancel this order? This cannot be undone.")) return;
                cancelOrder.mutate(
                  { orderId: order.orderId },
                  {
                    onSuccess: () => notify("Order cancelled.", "success"),
                    onError: (err) =>
                      notify(err instanceof ApiError ? err.message : "Could not cancel.", "error"),
                  },
                );
              }}
            >
              Cancel order
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          {/* --------------------------- items --------------------------- */}
          <Card className="p-6">
            <h2 className="mb-4 font-semibold">Items</h2>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {order.items.map((item) => (
                <li key={item.orderItemId} className="flex gap-4 py-4 first:pt-0 last:pb-0">
                  <Link
                    to={`/products/${item.productId}`}
                    className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800"
                  >
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full place-items-center" aria-hidden="true">
                        📦
                      </div>
                    )}
                  </Link>
                  <div className="flex-1">
                    <Link
                      to={`/products/${item.productId}`}
                      className="font-medium transition hover:text-brand-600"
                    >
                      {item.name}
                    </Link>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {formatMoney(item.unitPriceCents, order.currency)} × {item.quantity}
                    </p>
                  </div>
                  <p className="font-medium">{formatMoney(item.totalCents, order.currency)}</p>
                </li>
              ))}
            </ul>
          </Card>

          {/* -------------------------- timeline -------------------------- */}
          {order.timeline.length > 0 && (
            <Card className="p-6">
              <h2 className="mb-4 font-semibold">Order history</h2>
              <ol className="space-y-4">
                {order.timeline.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                          index === order.timeline.length - 1
                            ? "bg-brand-600"
                            : "bg-slate-300 dark:bg-slate-600"
                        }`}
                        aria-hidden="true"
                      />
                      {index < order.timeline.length - 1 && (
                        <span
                          className="w-px flex-1 bg-slate-200 dark:bg-slate-700"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="pb-1">
                      <p className="text-sm font-medium">{humanise(event.status)}</p>
                      {event.note && (
                        <p className="text-sm text-slate-600 dark:text-slate-400">{event.note}</p>
                      )}
                      <time className="text-xs text-slate-500" dateTime={event.at}>
                        {formatDateTime(event.at)}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>

        {/* --------------------------- sidebar --------------------------- */}
        <aside className="space-y-6">
          <Card className="p-6">
            <h2 className="mb-3 font-semibold">Payment summary</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600 dark:text-slate-400">Subtotal</dt>
                <dd>{formatMoney(order.subtotalCents, order.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600 dark:text-slate-400">Shipping</dt>
                <dd>
                  {order.shippingCents === 0
                    ? "Free"
                    : formatMoney(order.shippingCents, order.currency)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600 dark:text-slate-400">VAT</dt>
                <dd>{formatMoney(order.taxCents, order.currency)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 font-semibold dark:border-slate-700">
                <dt>Total</dt>
                <dd>{formatMoney(order.totalCents, order.currency)}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-6">
            <h2 className="mb-3 font-semibold">Delivery address</h2>
            <address className="text-sm not-italic text-slate-600 dark:text-slate-400">
              {order.shippingAddress.recipientName}
              <br />
              {order.shippingAddress.addressLine1}
              {order.shippingAddress.addressLine2 && (
                <>
                  <br />
                  {order.shippingAddress.addressLine2}
                </>
              )}
              <br />
              {order.shippingAddress.zip} {order.shippingAddress.city}
              <br />
              {order.shippingAddress.country}
            </address>
          </Card>

          {order.shipment && (
            <Card className="p-6">
              <h2 className="mb-3 font-semibold">Shipment</h2>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-600 dark:text-slate-400">Carrier</dt>
                  <dd>{order.shipment.carrier}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-600 dark:text-slate-400">Status</dt>
                  <dd>{humanise(order.shipment.status)}</dd>
                </div>
                {order.shipment.trackingNumber && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-600 dark:text-slate-400">Tracking</dt>
                    <dd className="font-mono text-xs">{order.shipment.trackingNumber}</dd>
                  </div>
                )}
                {order.shipment.estimatedDelivery && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-600 dark:text-slate-400">Estimated</dt>
                    <dd>{order.shipment.estimatedDelivery}</dd>
                  </div>
                )}
              </dl>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
