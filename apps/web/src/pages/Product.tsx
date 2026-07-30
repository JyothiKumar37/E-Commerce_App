import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useAddToCart,
  useCreateReview,
  useProduct,
  useRelatedProducts,
  useReviews,
  useTrackView,
} from "@/hooks/queries";
import { useAuth } from "@/store/auth";
import { useToast } from "@/store/toast";
import { ApiError } from "@/lib/api";
import { formatDate, formatMoney, humanise } from "@/lib/format";
import { ProductCard } from "@/components/ProductCard";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  ErrorState,
  Field,
  PageSpinner,
  Rating,
  Select,
  TextInput,
} from "@/components/ui";

export function ProductPage() {
  const { productId } = useParams<{ productId: string }>();
  const { user } = useAuth();
  const { notify } = useToast();

  const { data: product, isLoading, isError, error, refetch } = useProduct(productId);
  const { data: related } = useRelatedProducts(productId);
  const [reviewSort, setReviewSort] = useState("newest");
  const { data: reviews } = useReviews(productId, { sort: reviewSort, pageSize: 10 });

  const addToCart = useAddToCart();
  const trackView = useTrackView();
  const [quantity, setQuantity] = useState(1);

  // Record a view once per product visit; feeds the recommendation batch.
  useEffect(() => {
    if (productId) trackView.mutate(productId);
    setQuantity(1);
    // trackView is a stable mutation object; excluding it avoids a re-fire loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  if (isLoading) return <PageSpinner label="Loading product" />;
  if (isError || !product) {
    return (
      <ErrorState
        title="Product not found"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => refetch()}
      />
    );
  }

  const maxQuantity = Math.min(product.available ?? 20, 20);

  const handleAdd = () => {
    if (!user) {
      notify("Please sign in to add items to your cart.", "info");
      return;
    }
    addToCart.mutate(
      { productId: product.productId, quantity },
      {
        onSuccess: () => notify(`${product.name} added to cart.`, "success"),
        onError: (err) => notify(err instanceof ApiError ? err.message : "Could not add.", "error"),
      },
    );
  };

  return (
    <div className="space-y-16">
      <Breadcrumbs
        items={[
          { label: "Home", to: "/" },
          {
            label: product.category,
            to: `/search?category=${encodeURIComponent(product.category)}`,
          },
          { label: product.name },
        ]}
      />

      <div className="grid gap-10 lg:grid-cols-2">
        {/* ---------------------------- image --------------------------- */}
        <div className="overflow-hidden rounded-2xl bg-slate-100 dark:bg-slate-800">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="aspect-square w-full object-cover"
              // The hero image is above the fold: load it eagerly and give it
              // priority over the lazy grid images.
              loading="eager"
              fetchPriority="high"
            />
          ) : (
            <div className="grid aspect-square place-items-center text-6xl" aria-hidden="true">
              📦
            </div>
          )}
        </div>

        {/* ---------------------------- detail -------------------------- */}
        <div className="space-y-6">
          <div>
            {product.brand && (
              <p className="text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {product.brand}
              </p>
            )}
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{product.name}</h1>
            <div className="mt-3 flex items-center gap-3">
              <Rating value={product.ratingAvg} count={product.ratingCount} size="md" />
              {product.ratingCount > 0 && (
                <a href="#reviews" className="text-sm text-brand-600 hover:underline">
                  Read reviews
                </a>
              )}
            </div>
          </div>

          <p className="text-3xl font-semibold">
            {formatMoney(product.priceCents, product.currency)}
          </p>

          <div>
            {product.inStock ? (
              (product.available ?? 0) <= 5 ? (
                <Badge tone="warning">Only {product.available} left in stock</Badge>
              ) : (
                <Badge tone="success">In stock</Badge>
              )
            ) : (
              <Badge tone="danger">Sold out</Badge>
            )}
          </div>

          <p className="leading-relaxed text-slate-700 dark:text-slate-300">
            {product.description}
          </p>

          {Object.keys(product.attributes).length > 0 && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-slate-200 pt-6 text-sm dark:border-slate-800">
              {Object.entries(product.attributes).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-slate-500 dark:text-slate-400">{humanise(key)}</dt>
                  <dd className="font-medium">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}

          <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-6 dark:border-slate-800">
            <div className="w-24">
              <label htmlFor="quantity" className="mb-1.5 block text-sm font-medium">
                Quantity
              </label>
              <Select
                id="quantity"
                value={quantity}
                disabled={!product.inStock}
                onChange={(e) => setQuantity(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(maxQuantity, 1) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>

            <Button
              size="lg"
              disabled={!product.inStock}
              loading={addToCart.isPending}
              onClick={handleAdd}
              className="flex-1 sm:flex-none"
            >
              {product.inStock ? "Add to cart" : "Sold out"}
            </Button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            SKU {product.sku} · Free standard delivery over €50 · 30-day returns
          </p>
        </div>
      </div>

      {/* --------------------------- reviews ---------------------------- */}
      <section id="reviews" className="scroll-mt-20">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">
            Reviews {reviews?.summary.total ? `(${reviews.summary.total})` : ""}
          </h2>
          {reviews && reviews.summary.total > 0 && (
            <Select
              value={reviewSort}
              onChange={(e) => setReviewSort(e.target.value)}
              className="w-44"
            >
              <option value="newest">Most recent</option>
              <option value="helpful">Most helpful</option>
              <option value="highest">Highest rated</option>
              <option value="lowest">Lowest rated</option>
            </Select>
          )}
        </div>

        <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
          <div className="space-y-6">
            {reviews && reviews.summary.total > 0 && (
              <Card className="p-5">
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-bold">{reviews.summary.average.toFixed(1)}</span>
                  <span className="text-sm text-slate-500">out of 5</span>
                </div>
                <div className="mt-2">
                  <Rating value={reviews.summary.average} />
                </div>

                <ul className="mt-4 space-y-1.5">
                  {[5, 4, 3, 2, 1].map((star) => {
                    const count = reviews.summary.histogram[String(star)] ?? 0;
                    const percent = reviews.summary.total
                      ? (count / reviews.summary.total) * 100
                      : 0;
                    return (
                      <li key={star} className="flex items-center gap-2 text-xs">
                        <span className="w-6 text-slate-500">{star}★</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                          <div
                            className="h-full rounded-full bg-amber-400"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <span className="w-8 text-right text-slate-500">{count}</span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {user ? (
              <ReviewForm
                productId={product.productId}
                alreadyReviewed={reviews?.items?.some((r) => r.isMine)}
              />
            ) : (
              <Alert kind="info">
                <Link to="/signin" className="font-medium underline">
                  Sign in
                </Link>{" "}
                to write a review.
              </Alert>
            )}
          </div>

          <div className="space-y-4">
            {!reviews || reviews.items.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No reviews yet. Be the first to share your experience.
              </p>
            ) : (
              reviews.items.map((review) => (
                <Card key={review.reviewId} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <Rating value={review.rating} />
                        {review.isVerifiedPurchase && (
                          <Badge tone="success">Verified purchase</Badge>
                        )}
                        {review.isMine && <Badge tone="info">Your review</Badge>}
                      </div>
                      {review.title && <h3 className="mt-2 font-medium">{review.title}</h3>}
                    </div>
                    <time className="text-xs text-slate-500" dateTime={review.createdAt}>
                      {formatDate(review.createdAt)}
                    </time>
                  </div>

                  <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {review.body}
                  </p>

                  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                    {review.author.displayName}
                  </p>
                </Card>
              ))
            )}
          </div>
        </div>
      </section>

      {/* --------------------------- related ---------------------------- */}
      {related && related.recommendations.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-semibold">
            {related.strategy.startsWith("affinity")
              ? "Customers also bought"
              : "More in this category"}
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {related.recommendations.map((item) => (
              <ProductCard key={item.productId} product={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ReviewForm({
  productId,
  alreadyReviewed,
}: {
  productId: string;
  alreadyReviewed?: boolean;
}) {
  const { notify } = useToast();
  const createReview = useCreateReview();
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  if (alreadyReviewed) {
    return <Alert kind="info">You have already reviewed this product.</Alert>;
  }

  return (
    <Card className="space-y-4 p-5">
      <h3 className="font-medium">Write a review</h3>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          createReview.mutate(
            { productId, rating, title: title || undefined, body },
            {
              onSuccess: () => {
                notify("Thanks for your review.", "success");
                setTitle("");
                setBody("");
                setRating(5);
              },
              onError: (err) =>
                notify(err instanceof ApiError ? err.message : "Could not submit review.", "error"),
            },
          );
        }}
      >
        <Field label="Rating" htmlFor="review-rating" required>
          <Select
            id="review-rating"
            value={rating}
            onChange={(e) => setRating(Number(e.target.value))}
          >
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} star{n === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Title" htmlFor="review-title">
          <TextInput
            id="review-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Sum it up in a few words"
          />
        </Field>

        <Field
          label="Your review"
          htmlFor="review-body"
          required
          hint={`${body.length}/5000 · at least 10 characters`}
        >
          <textarea
            id="review-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            minLength={10}
            maxLength={5000}
            required
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-900"
            placeholder="What did you like or dislike? How did you use it?"
          />
        </Field>

        <Button
          type="submit"
          fullWidth
          loading={createReview.isPending}
          disabled={body.trim().length < 10}
        >
          Submit review
        </Button>
      </form>
    </Card>
  );
}
