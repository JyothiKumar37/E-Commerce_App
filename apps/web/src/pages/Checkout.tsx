import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useAddresses,
  useCheckoutPreview,
  usePlaceOrder,
  type PlaceOrderInput,
} from "@/hooks/queries";
import { useAuth } from "@/store/auth";
import { useToast } from "@/store/toast";
import { ApiError, newIdempotencyKey } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  PageSpinner,
  Select,
  TextInput,
} from "@/components/ui";

type Step = "address" | "payment" | "review";

/** Deterministic tokens the mock PSP recognises. A real integration would swap
 *  this block for the provider's client SDK, which tokenises the card in the
 *  browser so a PAN never touches our servers. */
const TEST_TOKENS = [
  { value: "tok_test_success", label: "Approved" },
  { value: "tok_test_decline", label: "Declined by bank" },
  { value: "tok_test_insufficient_funds", label: "Insufficient funds" },
  { value: "tok_test_expired", label: "Expired card" },
];

export function CheckoutPage() {
  const { user, initialising } = useAuth();
  const navigate = useNavigate();
  const { notify } = useToast();

  const [step, setStep] = useState<Step>("address");
  const [addressId, setAddressId] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PlaceOrderInput["paymentMethod"]>("card");
  const [paymentToken, setPaymentToken] = useState("tok_test_success");
  const [cardLast4, setCardLast4] = useState("4242");
  const [shippingMethod, setShippingMethod] =
    useState<NonNullable<PlaceOrderInput["shippingMethod"]>>("standard");

  /**
   * Generated once per mounted checkout and reused across every retry, so a
   * declined-then-corrected attempt cannot create two orders. Regenerated only
   * after a successful order.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  const { data: addresses, isLoading: addressesLoading } = useAddresses(Boolean(user));
  const preview = useCheckoutPreview(addressId, Boolean(user) && Boolean(addressId));
  const placeOrder = usePlaceOrder();

  // Default to the user's saved default address.
  useEffect(() => {
    if (!addressId && addresses && addresses.length > 0) {
      setAddressId((addresses.find((a) => a.isDefault) ?? addresses[0])!.addressId);
    }
  }, [addresses, addressId]);

  const selectedAddress = useMemo(
    () => addresses?.find((a) => a.addressId === addressId) ?? null,
    [addresses, addressId],
  );

  if (initialising || addressesLoading) return <PageSpinner />;

  if (!user) {
    return (
      <EmptyState
        icon="🔐"
        title="Sign in to check out"
        action={
          <Link to="/signin?next=/checkout">
            <Button>Sign in</Button>
          </Link>
        }
      />
    );
  }

  if (!addresses || addresses.length === 0) {
    return (
      <EmptyState
        icon="📍"
        title="Add a delivery address"
        description="We need somewhere to send your order before you can check out."
        action={
          <Link to="/account/addresses?next=/checkout">
            <Button>Add an address</Button>
          </Link>
        }
      />
    );
  }

  const totals = preview.data?.totals;

  const submit = () => {
    if (!addressId || !totals) return;

    placeOrder.mutate(
      {
        shippingAddressId: addressId,
        paymentMethod,
        paymentToken,
        cardLast4: paymentMethod === "card" ? cardLast4 : null,
        cardBrand: paymentMethod === "card" ? "Visa" : null,
        shippingMethod,
        // The server recomputes this and refuses the order if it disagrees,
        // so the customer can never be charged a total they did not see.
        expectedTotalCents: totals.totalCents,
        idempotencyKey,
      },
      {
        onSuccess: (data) => {
          setIdempotencyKey(newIdempotencyKey());
          navigate(`/orders/${data.order.orderId}?placed=1`);
        },
        onError: (err) => {
          const message =
            err instanceof ApiError ? err.message : "Checkout failed. Please try again.";
          notify(message, "error");
          // A price change means the review step is stale; send them back.
          if (err instanceof ApiError && err.code === "ORDER_PRICE_CHANGED") {
            preview.refetch();
            setStep("review");
          }
        },
      },
    );
  };

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold tracking-tight">Checkout</h1>

      <Steps current={step} />

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {/* --------------------------- address -------------------------- */}
          {step === "address" && (
            <Card className="space-y-5 p-6">
              <h2 className="font-semibold">Delivery address</h2>

              <fieldset className="space-y-3">
                <legend className="sr-only">Choose a delivery address</legend>
                {addresses.map((address) => (
                  <label
                    key={address.addressId}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition ${
                      addressId === address.addressId
                        ? "border-brand-500 bg-brand-50 dark:bg-brand-950/40"
                        : "border-slate-200 hover:border-slate-300 dark:border-slate-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name="address"
                      value={address.addressId}
                      checked={addressId === address.addressId}
                      onChange={() => setAddressId(address.addressId)}
                      className="mt-1 h-4 w-4 text-brand-600 focus:ring-brand-500"
                    />
                    <div className="text-sm">
                      <p className="font-medium">{address.recipientName}</p>
                      <p className="text-slate-600 dark:text-slate-400">
                        {address.addressLine1}
                        {address.addressLine2 ? `, ${address.addressLine2}` : ""}
                      </p>
                      <p className="text-slate-600 dark:text-slate-400">
                        {address.zip} {address.city}, {address.country}
                      </p>
                    </div>
                  </label>
                ))}
              </fieldset>

              <Link
                to="/account/addresses"
                className="inline-block text-sm text-brand-600 hover:underline"
              >
                + Add a new address
              </Link>

              <div>
                <Field label="Delivery speed" htmlFor="shipping-method">
                  <Select
                    id="shipping-method"
                    value={shippingMethod}
                    onChange={(e) =>
                      setShippingMethod(
                        e.target.value as NonNullable<PlaceOrderInput["shippingMethod"]>,
                      )
                    }
                  >
                    <option value="standard">Standard (3–5 business days)</option>
                    <option value="express">Express (2 business days)</option>
                    <option value="overnight">Overnight (next business day)</option>
                  </Select>
                </Field>
              </div>

              <Button onClick={() => setStep("payment")} disabled={!addressId}>
                Continue to payment
              </Button>
            </Card>
          )}

          {/* --------------------------- payment -------------------------- */}
          {step === "payment" && (
            <Card className="space-y-5 p-6">
              <h2 className="font-semibold">Payment</h2>

              <Alert kind="info">
                This is a demo environment using a mock payment provider. No real card details are
                accepted, transmitted or stored — pick a test outcome below.
              </Alert>

              <Field label="Payment method" htmlFor="payment-method">
                <Select
                  id="payment-method"
                  value={paymentMethod}
                  onChange={(e) =>
                    setPaymentMethod(e.target.value as PlaceOrderInput["paymentMethod"])
                  }
                >
                  <option value="card">Card</option>
                  <option value="paypal">PayPal</option>
                  <option value="sepa">SEPA direct debit</option>
                  <option value="invoice">Invoice</option>
                </Select>
              </Field>

              <Field
                label="Test outcome"
                htmlFor="payment-token"
                hint="Drives what the mock provider returns."
              >
                <Select
                  id="payment-token"
                  value={paymentToken}
                  onChange={(e) => setPaymentToken(e.target.value)}
                >
                  {TEST_TOKENS.map((token) => (
                    <option key={token.value} value={token.value}>
                      {token.label}
                    </option>
                  ))}
                </Select>
              </Field>

              {paymentMethod === "card" && (
                <Field label="Last 4 digits (display only)" htmlFor="card-last4">
                  <TextInput
                    id="card-last4"
                    value={cardLast4}
                    maxLength={4}
                    inputMode="numeric"
                    pattern="\d{4}"
                    onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ""))}
                  />
                </Field>
              )}

              <div className="flex gap-3">
                <Button variant="secondary" onClick={() => setStep("address")}>
                  Back
                </Button>
                <Button onClick={() => setStep("review")}>Review order</Button>
              </div>
            </Card>
          )}

          {/* --------------------------- review --------------------------- */}
          {step === "review" && (
            <Card className="space-y-5 p-6">
              <h2 className="font-semibold">Review and confirm</h2>

              {preview.isError && (
                <Alert kind="error">
                  {preview.error instanceof ApiError
                    ? preview.error.message
                    : "Could not load your order summary."}
                </Alert>
              )}

              {preview.data?.unavailable && preview.data.unavailable.length > 0 && (
                <Alert kind="warning">
                  Some items became unavailable.{" "}
                  <Link to="/cart" className="font-medium underline">
                    Review your cart
                  </Link>{" "}
                  before continuing.
                </Alert>
              )}

              <div className="space-y-4 text-sm">
                <section>
                  <h3 className="mb-1 font-medium">Delivering to</h3>
                  {selectedAddress && (
                    <p className="text-slate-600 dark:text-slate-400">
                      {selectedAddress.recipientName}, {selectedAddress.addressLine1},{" "}
                      {selectedAddress.zip} {selectedAddress.city}, {selectedAddress.country}
                    </p>
                  )}
                </section>

                <section>
                  <h3 className="mb-1 font-medium">Paying with</h3>
                  <p className="text-slate-600 dark:text-slate-400">
                    {paymentMethod === "card"
                      ? `Card ending ${cardLast4}`
                      : paymentMethod.toUpperCase()}
                  </p>
                </section>

                <section>
                  <h3 className="mb-2 font-medium">Items</h3>
                  <ul className="space-y-2">
                    {preview.data?.items.map((item) => (
                      <li key={item.productId} className="flex justify-between gap-4">
                        <span className="text-slate-600 dark:text-slate-400">
                          {item.name} × {item.quantity}
                        </span>
                        <span>{formatMoney(item.lineTotalCents, item.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => setStep("payment")}
                  disabled={placeOrder.isPending}
                >
                  Back
                </Button>
                <Button
                  size="lg"
                  loading={placeOrder.isPending}
                  disabled={!totals || preview.isError}
                  onClick={submit}
                >
                  {totals ? `Pay ${formatMoney(totals.totalCents, preview.data?.currency)}` : "Pay"}
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* ---------------------------- summary --------------------------- */}
        <aside>
          <Card className="sticky top-24 space-y-4 p-6">
            <h2 className="font-semibold">Order summary</h2>

            {preview.isLoading ? (
              <PageSpinner />
            ) : totals ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Subtotal</dt>
                  <dd>{formatMoney(totals.subtotalCents, preview.data?.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Shipping</dt>
                  <dd>
                    {totals.shippingCents === 0 ? (
                      <span className="text-emerald-600">Free</span>
                    ) : (
                      formatMoney(totals.shippingCents, preview.data?.currency)
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">
                    VAT ({Math.round((preview.data?.taxRate ?? 0.19) * 100)}%)
                  </dt>
                  <dd>{formatMoney(totals.taxCents, preview.data?.currency)}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold dark:border-slate-700">
                  <dt>Total</dt>
                  <dd>{formatMoney(totals.totalCents, preview.data?.currency)}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">Select an address to see your total.</p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "address", label: "Address" },
    { key: "payment", label: "Payment" },
    { key: "review", label: "Review" },
  ];
  const currentIndex = steps.findIndex((s) => s.key === current);

  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Checkout progress">
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={step.key} className="flex items-center gap-2">
            {index > 0 && (
              <span className="text-slate-300" aria-hidden="true">
                —
              </span>
            )}
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={
                state === "current"
                  ? "font-semibold text-brand-600"
                  : state === "done"
                    ? "text-slate-600 dark:text-slate-400"
                    : "text-slate-400"
              }
            >
              {state === "done" ? "✓ " : `${index + 1}. `}
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
