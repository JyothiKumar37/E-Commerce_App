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
