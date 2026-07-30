import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { Spinner } from "./ui";
import { useAuth } from "@/store/auth";
import { useCart } from "@/hooks/queries";
import { classNames } from "@/lib/format";

export function Layout() {
  const { user, signOut, initialising } = useAuth();
  const { data: cart } = useCart(Boolean(user));
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [menuOpen, setMenuOpen] = useState(false);

  // Keep the visible search box in step with the URL when the user navigates
  // back, or lands on /search from a link.
  useEffect(() => {
    setQuery(searchParams.get("q") ?? "");
  }, [searchParams]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    navigate(`/search?q=${encodeURIComponent(query.trim())}`);
    setMenuOpen(false);
  };

  const itemCount = cart?.itemCount ?? 0;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Lets keyboard users jump past the nav on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight"
          >
            <span
              className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white"
              aria-hidden="true"
            >
              N
            </span>
            <span className="hidden sm:inline">Northwind</span>
          </Link>

          <form onSubmit={submitSearch} className="flex flex-1 items-center" role="search">
            <label htmlFor="global-search" className="sr-only">
              Search products
            </label>
            <input
              id="global-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search products…"
              className="w-full rounded-l-lg border border-r-0 border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900"
            />
            <button
              type="submit"
              className="rounded-r-lg border border-brand-600 bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
            >
              <span className="sr-only sm:not-sr-only">Search</span>
              <span aria-hidden="true" className="sm:hidden">
                🔍
              </span>
            </button>
          </form>

          <nav className="flex items-center gap-1" aria-label="Main">
            <Link
              to="/cart"
              className="relative rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <span aria-hidden="true">🛒</span>
              <span className="sr-only sm:not-sr-only sm:ml-1">Cart</span>
              {itemCount > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-xs font-semibold text-white"
                  aria-label={`${itemCount} items in cart`}
                >
                  {itemCount > 99 ? "99+" : itemCount}
                </span>
              )}
            </Link>

            {initialising ? (
              <Spinner className="mx-3 h-5 w-5 text-slate-400" />
            ) : user ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {user.firstName}
                  <span aria-hidden="true" className="ml-1 text-xs">
                    ▾
                  </span>
                </button>

                {menuOpen && (
                  <>
                    {/* Click-outside catcher. */}
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setMenuOpen(false)}
                      aria-hidden="true"
                    />
                    <div
                      role="menu"
                      className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
                    >
                      {[
                        { to: "/orders", label: "My orders" },
                        { to: "/account", label: "Account settings" },
                        { to: "/account/addresses", label: "Addresses" },
                      ].map((item) => (
                        <Link
                          key={item.to}
                          to={item.to}
                          role="menuitem"
                          onClick={() => setMenuOpen(false)}
                          className="block px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          {item.label}
                        </Link>
                      ))}
                      <hr className="my-1 border-slate-200 dark:border-slate-700" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={async () => {
                          setMenuOpen(false);
                          await signOut();
                          navigate("/");
                        }}
                        className="block w-full px-4 py-2 text-left text-sm text-red-600 transition hover:bg-red-50 dark:hover:bg-red-950/40"
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <NavLink
                to="/signin"
                className={({ isActive }) =>
                  classNames(
                    "rounded-lg px-3 py-2 text-sm font-medium transition",
                    isActive
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                  )
                }
              >
                Sign in
              </NavLink>
            )}
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white py-8 dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto max-w-7xl px-4 text-sm text-slate-500 sm:px-6 lg:px-8 dark:text-slate-400">
          <div className="flex flex-col justify-between gap-4 sm:flex-row">
            <p>© {new Date().getFullYear()} Northwind Store. A reference commerce platform.</p>
            <nav aria-label="Footer" className="flex gap-4">
              <Link to="/search" className="transition hover:text-brand-600">
                All products
              </Link>
              <Link to="/orders" className="transition hover:text-brand-600">
                Orders
              </Link>
              <Link to="/account" className="transition hover:text-brand-600">
                Account
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
