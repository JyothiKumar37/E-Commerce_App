import { Link } from "react-router-dom";
import { useAuth } from "@/store/auth";
import { useAddToCart, useCategories, useRecommendations, useSearch } from "@/hooks/queries";
import { useToast } from "@/store/toast";
import { ApiError } from "@/lib/api";
import { ProductCard } from "@/components/ProductCard";
import { Button, ProductCardSkeleton } from "@/components/ui";

export function HomePage() {
  const { user } = useAuth();
  const { notify } = useToast();

  const newest = useSearch({ sort: "newest", pageSize: 8 });
  const { data: categories } = useCategories();
  const trending = useRecommendations("trending", 4);
  const forMe = useRecommendations("for-me", 4);

  const addToCart = useAddToCart();

  const handleAdd = (productId: string) => {
    if (!user) {
      notify("Please sign in to add items to your cart.", "info");
      return;
    }
    addToCart.mutate(
      { productId, quantity: 1 },
      {
        onSuccess: () => notify("Added to cart.", "success"),
        onError: (error) =>
          notify(error instanceof ApiError ? error.message : "Could not add to cart.", "error"),
      },
    );
  };

  return (
    <div className="space-y-16">
      {/* ---------------------------- hero ---------------------------- */}
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 to-brand-800 px-6 py-16 text-white sm:px-12 sm:py-24">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">
            Everyday essentials, built to last.
          </h1>
          <p className="mt-4 text-lg text-brand-100">
            Apparel, electronics and home goods chosen for quality over churn. Free standard
            delivery on orders over €50.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/search">
              <Button size="lg" variant="secondary">
                Shop all products
              </Button>
            </Link>
            {!user && (
              <Link to="/signup">
                <Button
                  size="lg"
                  className="border border-white/30 bg-white/10 text-white hover:bg-white/20"
                >
                  Create an account
                </Button>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* -------------------------- categories ------------------------- */}
      {categories && categories.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-semibold">Shop by category</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {categories.map((entry) => (
              <Link
                key={entry.category}
                to={`/search?category=${encodeURIComponent(entry.category)}`}
                className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center transition hover:border-brand-400 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <p className="font-medium">{entry.category}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {entry.count} {entry.count === 1 ? "item" : "items"}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------ personalised ------------------------- */}
      {user && !!forMe.data?.recommendations?.length && (
        <Shelf
          title="Picked for you"
          subtitle={
            forMe.data.strategy === "personalised"
              ? "Based on what you've bought and viewed"
              : undefined
          }
          products={forMe.data.recommendations}
          onAdd={handleAdd}
          adding={addToCart.isPending}
        />
      )}

      {/* --------------------------- newest ---------------------------- */}
      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-xl font-semibold">New arrivals</h2>
          <Link
            to="/search?sort=newest"
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            View all →
          </Link>
        </div>

        {newest.isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {newest.data?.items?.map((product) => (
              <ProductCard
                key={product.productId}
                product={product}
                onAddToCart={handleAdd}
                adding={addToCart.isPending && addToCart.variables?.productId === product.productId}
              />
            ))}
          </div>
        )}
      </section>

      {/* -------------------------- trending --------------------------- */}
      {!!trending.data?.recommendations?.length && (
        <Shelf
          title="Trending this week"
          products={trending.data.recommendations}
          onAdd={handleAdd}
          adding={addToCart.isPending}
        />
      )}
    </div>
  );
}

function Shelf({
  title,
  subtitle,
  products,
  onAdd,
  adding,
}: {
  title: string;
  subtitle?: string;
  products: Parameters<typeof ProductCard>[0]["product"][];
  onAdd: (productId: string) => void;
  adding: boolean;
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {products.map((product) => (
          <ProductCard
            key={product.productId}
            product={product}
            onAddToCart={onAdd}
            adding={adding}
          />
        ))}
      </div>
    </section>
  );
}
