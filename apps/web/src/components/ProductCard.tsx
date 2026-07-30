import { Link } from "react-router-dom";
import { Badge, Button, Rating } from "./ui";
import { formatMoney } from "@/lib/format";
import type { Product, Recommendation } from "@/lib/types";

interface ProductCardProps {
  product: Product | Recommendation;
  onAddToCart?: (productId: string) => void;
  adding?: boolean;
}

export function ProductCard({ product, onAddToCart, adding }: ProductCardProps) {
  const soldOut = !product.inStock;
  // `available` is only present on detailed payloads, not on search hits.
  const lowStock = !soldOut && typeof product.available === "number" && product.available <= 5;

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <Link
        to={`/products/${product.productId}`}
        className="relative block aspect-square overflow-hidden bg-slate-100 dark:bg-slate-800"
      >
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            // Below-the-fold images should not block first paint.
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-4xl text-slate-300"
            aria-hidden="true"
          >
            📦
          </div>
        )}

        {soldOut && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-950/70">
            <Badge tone="danger">Sold out</Badge>
          </div>
        )}
        {lowStock && (
          <div className="absolute left-2 top-2">
            <Badge tone="warning">Only {product.available} left</Badge>
          </div>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {product.brand ?? product.category}
        </p>

        <h3 className="text-sm font-medium leading-snug text-slate-900 dark:text-slate-100">
          <Link to={`/products/${product.productId}`} className="transition hover:text-brand-600">
            {product.name}
          </Link>
        </h3>

        <Rating value={product.ratingAvg} count={product.ratingCount} />

        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <span className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {formatMoney(product.priceCents, product.currency)}
          </span>

          {onAddToCart && (
            <Button
              size="sm"
              disabled={soldOut}
              loading={adding}
              onClick={() => onAddToCart(product.productId)}
              aria-label={soldOut ? `${product.name} is sold out` : `Add ${product.name} to cart`}
            >
              {soldOut ? "Sold out" : "Add"}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
