import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAddToCart, useSearch, type SearchParams } from "@/hooks/queries";
import { useAuth } from "@/store/auth";
import { useToast } from "@/store/toast";
import { ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { ProductCard } from "@/components/ProductCard";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Pagination,
  ProductCardSkeleton,
  Select,
} from "@/components/ui";

/**
 * All filter state lives in the URL, so a filtered result set is shareable,
 * bookmarkable and survives a refresh or a back-button press.
 */
export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { notify } = useToast();
  const addToCart = useAddToCart();

  const params = useMemo<SearchParams>(() => {
    const asNumber = (key: string) => {
      const raw = searchParams.get(key);
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    return {
      q: searchParams.get("q") ?? "",
      category: searchParams.getAll("category"),
      brand: searchParams.getAll("brand"),
      minPrice: asNumber("minPrice"),
      maxPrice: asNumber("maxPrice"),
      inStock: searchParams.get("inStock") === "true" ? true : undefined,
      minRating: asNumber("minRating"),
      sort: (searchParams.get("sort") as SearchParams["sort"]) ?? "relevance",
      page: asNumber("page") ?? 1,
      pageSize: 24,
    };
  }, [searchParams]);

  const { data, isLoading, isError, error, refetch, isFetching } = useSearch(params);

  const update = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    // Any filter change invalidates the current page number.
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const toggleMulti = (key: "category" | "brand", value: string) => {
    update((next) => {
      const current = next.getAll(key);
      next.delete(key);
      const updated = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      updated.forEach((v) => next.append(key, v));
    });
  };

  const handleAdd = (productId: string) => {
    if (!user) {
      notify("Please sign in to add items to your cart.", "info");
      return;
    }
    addToCart.mutate(
      { productId, quantity: 1 },
      {
        onSuccess: () => notify("Added to cart.", "success"),
        onError: (err) => notify(err instanceof ApiError ? err.message : "Could not add.", "error"),
      },
    );
  };

  const activeFilterCount =
    params.category!.length +
    params.brand!.length +
    (params.minPrice != null ? 1 : 0) +
    (params.maxPrice != null ? 1 : 0) +
    (params.inStock ? 1 : 0) +
    (params.minRating != null ? 1 : 0);

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
      {/* ---------------------------- filters --------------------------- */}
      <aside className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Filters</h2>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => setSearchParams(params.q ? { q: params.q } : {}, { replace: true })}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              Clear all ({activeFilterCount})
            </button>
          )}
        </div>

        {data?.facets.categories && data.facets.categories.length > 0 && (
          <FacetGroup
            title="Category"
            options={data.facets.categories}
            selected={params.category ?? []}
            onToggle={(value) => toggleMulti("category", value)}
          />
        )}

        {data?.facets.brands && data.facets.brands.length > 0 && (
          <FacetGroup
            title="Brand"
            options={data.facets.brands}
            selected={params.brand ?? []}
            onToggle={(value) => toggleMulti("brand", value)}
          />
        )}

        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-medium">Price</h3>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              placeholder="Min"
              defaultValue={params.minPrice ?? ""}
              onBlur={(e) => update((next) => setOrDelete(next, "minPrice", e.target.value))}
              aria-label="Minimum price"
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900"
            />
            <span className="text-slate-400">–</span>
            <input
              type="number"
              min={0}
              placeholder="Max"
              defaultValue={params.maxPrice ?? ""}
              onBlur={(e) => update((next) => setOrDelete(next, "maxPrice", e.target.value))}
              aria-label="Maximum price"
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900"
            />
          </div>
          {data?.facets.price && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Range: {formatMoney(data.facets.price.minCents)} –{" "}
              {formatMoney(data.facets.price.maxCents)}
            </p>
          )}
        </Card>

        <Card className="space-y-3 p-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={params.inStock === true}
              onChange={(e) =>
                update((next) => setOrDelete(next, "inStock", e.target.checked ? "true" : ""))
              }
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            In stock only
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={params.minRating === 4}
              onChange={(e) =>
                update((next) => setOrDelete(next, "minRating", e.target.checked ? "4" : ""))
              }
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            4 stars and up
          </label>
        </Card>
      </aside>

      {/* ---------------------------- results --------------------------- */}
      <section>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              {params.q ? `Results for “${params.q}”` : "All products"}
            </h1>
            {data && (
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {data.total} {data.total === 1 ? "product" : "products"}
                {isFetching && " · updating…"}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="sort" className="text-sm text-slate-600 dark:text-slate-400">
              Sort
            </label>
            <Select
              id="sort"
              value={params.sort}
              onChange={(e) => update((next) => next.set("sort", e.target.value))}
              className="w-44"
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="rating">Highest rated</option>
            </Select>
          </div>
        </div>

        {/* Surfaced deliberately: the user should know results may be less
            relevant while the search index is unavailable. */}
        {data?.degraded && (
          <div className="mb-4">
            <Alert kind="warning">
              Search is running in a reduced mode right now, so results may be less precise than
              usual. Filtering and browsing still work normally.
            </Alert>
          </div>
        )}

        {isError ? (
          <ErrorState
            message={error instanceof ApiError ? error.message : "Could not load products."}
            onRetry={() => refetch()}
          />
        ) : isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 12 }, (_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="No products match those filters"
            description="Try removing a filter or searching for something broader."
            action={
              <Button variant="secondary" onClick={() => setSearchParams({}, { replace: true })}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {data?.items.map((product) => (
                <ProductCard
                  key={product.productId}
                  product={product}
                  onAddToCart={handleAdd}
                  adding={
                    addToCart.isPending && addToCart.variables?.productId === product.productId
                  }
                />
              ))}
            </div>

            <div className="mt-10">
              <Pagination
                page={data?.page ?? 1}
                totalPages={data?.totalPages ?? 1}
                onChange={(page) => {
                  const next = new URLSearchParams(searchParams);
                  next.set("page", String(page));
                  setSearchParams(next);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function FacetGroup({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: { value: string; count: number }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <ul className="space-y-2">
        {options.slice(0, 10).map((option) => (
          <li key={option.value}>
            <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => onToggle(option.value)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                {option.value}
              </span>
              <span className="text-xs text-slate-400">{option.count}</span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value === "" || value === null) params.delete(key);
  else params.set(key, value);
}
