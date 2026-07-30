import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { Button, EmptyState } from "@/components/ui";
import { HomePage } from "@/pages/Home";
import { SearchPage } from "@/pages/Search";
import { ProductPage } from "@/pages/Product";
import { CartPage } from "@/pages/Cart";
import { CheckoutPage } from "@/pages/Checkout";
import { OrderDetailPage, OrdersPage } from "@/pages/Orders";
import { SignInPage, SignUpPage } from "@/pages/Auth";
import { AccountLayout, AddressesPage, ProfilePage, SecurityPage } from "@/pages/Account";

/**
 * Catches render-time exceptions so one broken component shows a recoverable
 * message instead of unmounting the whole app to a blank white page.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // In production this is where a Sentry/OTel exporter would go.
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-16">
          <EmptyState
            icon="⚠️"
            title="Something went wrong"
            description="An unexpected error occurred while rendering this page."
            action={<Button onClick={() => window.location.reload()}>Reload the page</Button>}
          />

          {/*
            Show the actual message. A bare "something went wrong" forces
            whoever hits this to open devtools to learn anything at all, which
            is a poor trade for hiding a client-side error the visitor's own
            browser already has. Collapsed so it does not dominate the page.
          */}
          <details className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-300">
              Error details
            </summary>
            <p className="mt-3 font-mono text-xs text-red-700 dark:text-red-400">
              {this.state.error.name}: {this.state.error.message}
            </p>
            {this.state.error.stack && (
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-500 dark:text-slate-400">
                {this.state.error.stack}
              </pre>
            )}
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              A failed API call is the usual cause. Check the Network tab for a request to{" "}
              <code>/api/…</code> that did not return JSON.
            </p>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

function NotFoundPage() {
  return (
    <EmptyState
      icon="🧭"
      title="Page not found"
      description="The page you were looking for does not exist or has moved."
      action={
        <Link to="/">
          <Button>Back to home</Button>
        </Link>
      }
    />
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="products/:productId" element={<ProductPage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:orderId" element={<OrderDetailPage />} />
          <Route path="signin" element={<SignInPage />} />
          <Route path="signup" element={<SignUpPage />} />

          <Route path="account" element={<AccountLayout />}>
            <Route index element={<ProfilePage />} />
            <Route path="addresses" element={<AddressesPage />} />
            <Route path="security" element={<SecurityPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
