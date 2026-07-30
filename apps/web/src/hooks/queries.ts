import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "@/lib/api";
import type {
  Address,
  Cart,
  CartItem,
  CheckoutPreview,
  Facet,
  Order,
  OrderEvent,
  OrderItem,
  OrderSummary,
  Paginated,
  PlacedOrder,
  Product,
  Recommendation,
  Review,
  ReviewsResponse,
  SearchResponse,
  UnavailableItem,
  User,
} from "@/lib/types";

/**
 * Response normalisers.
 *
 * Every list endpoint is coerced to a complete shape before a component sees
 * it, so a missing or malformed field can never surface as
 * `Cannot read properties of undefined`. Guarding at each render site instead
 * means one forgotten `?.` takes down a whole route via the error boundary —
 * which is exactly what happened on the storefront home page.
 *
 * The API is trusted to be correct; this is about the failure mode when it is
 * not. A page that renders an empty shelf is recoverable, a blank error screen
 * is not.
 */
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const normalisePage = <T>(data: unknown): Paginated<T> => {
  const d = (data ?? {}) as Partial<Paginated<T>>;
  return {
    items: asArray<T>(d.items),
    page: d.page ?? 1,
    pageSize: d.pageSize ?? 0,
    total: d.total ?? 0,
    totalPages: d.totalPages ?? 0,
    hasNext: d.hasNext ?? false,
  };
};

/** Query keys in one place so invalidation cannot drift from subscription. */
export const keys = {
  catalog: ["catalog"] as const,
  search: (params: unknown) => ["catalog", "search", params] as const,
  product: (id: string) => ["catalog", "product", id] as const,
  categories: ["catalog", "categories"] as const,
  cart: ["cart"] as const,
  orders: (params: unknown) => ["orders", params] as const,
  order: (id: string) => ["orders", id] as const,
  addresses: ["account", "addresses"] as const,
  profile: ["account", "profile"] as const,
  reviews: (productId: string, params: unknown) => ["reviews", productId, params] as const,
  myReviews: ["reviews", "mine"] as const,
  recommendations: (kind: string, id?: string) => ["recommendations", kind, id] as const,
  checkoutPreview: (addressId?: string | null) => ["checkout", "preview", addressId] as const,
};

/* ------------------------------- catalog ------------------------------- */

export interface SearchParams {
  q?: string;
  category?: string[];
  brand?: string[];
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  minRating?: number;
  sort?: "relevance" | "price_asc" | "price_desc" | "rating" | "newest";
  page?: number;
  pageSize?: number;
}

export function useSearch(
  params: SearchParams,
  options?: Partial<UseQueryOptions<SearchResponse>>,
) {
  return useQuery({
    queryKey: keys.search(params),
    queryFn: () => api.post<SearchResponse>("/catalog/search", params),
    select: (data): SearchResponse => ({
      ...normalisePage<Product>(data),
      facets: {
        categories: asArray<Facet>(data?.facets?.categories),
        brands: asArray<Facet>(data?.facets?.brands),
        price: data?.facets?.price ?? null,
      },
      degraded: data?.degraded ?? false,
    }),
    // Search results are cheap to refetch but jarring to see change mid-scroll.
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    ...options,
  });
}

export function useProduct(productId: string | undefined) {
  return useQuery({
    queryKey: keys.product(productId ?? ""),
    queryFn: () => api.get<{ product: Product }>(`/catalog/products/${productId}`),
    select: (data): Product => ({
      ...((data?.product ?? {}) as Product),
      // Feeds Object.keys(), which throws outright on undefined.
      attributes: data?.product?.attributes ?? {},
    }),
    enabled: Boolean(productId),
    staleTime: 60_000,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: () =>
      api.get<{ categories: { category: string; count: number }[] }>("/catalog/categories"),
    select: (data) => asArray<{ category: string; count: number }>(data?.categories),
    staleTime: 5 * 60_000,
  });
}

/** Fire-and-forget view tracking; failures must never disturb the page. */
export function useTrackView() {
  return useMutation({
    mutationFn: (productId: string) =>
      api.post(`/catalog/products/${productId}/views`, { sessionId: sessionKey() }),
    onError: () => undefined,
    retry: false,
  });
}

function sessionKey(): string {
  const existing = sessionStorage.getItem("ecom_session");
  if (existing) return existing;
  const created = newIdempotencyKey();
  sessionStorage.setItem("ecom_session", created);
  return created;
}

/* --------------------------------- cart -------------------------------- */

export function useCart(enabled: boolean) {
  return useQuery({
    queryKey: keys.cart,
    queryFn: () => api.get<{ cart: Cart }>("/cart"),
    select: (data): Cart => ({
      ...((data?.cart ?? {}) as Cart),
      items: asArray<CartItem>(data?.cart?.items),
      unavailable: asArray<UnavailableItem>(data?.cart?.unavailable),
    }),
    enabled,
    staleTime: 0,
  });
}

export function useAddToCart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { productId: string; quantity: number }) =>
      api.post<{ cart: Cart }>("/cart/items", input),
    onSuccess: (data) => {
      // The server returns the authoritative cart, so write it straight into
      // the cache instead of triggering another round trip.
      queryClient.setQueryData(keys.cart, data);
    },
  });
}

export function useUpdateCartItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, quantity }: { productId: string; quantity: number }) =>
      api.patch<{ cart: Cart }>(`/cart/items/${productId}`, { quantity }),
    onSuccess: (data) => queryClient.setQueryData(keys.cart, data),
  });
}

export function useRemoveCartItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) => api.delete<{ cart: Cart }>(`/cart/items/${productId}`),
    onSuccess: (data) => queryClient.setQueryData(keys.cart, data),
  });
}

export function useClearCart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete("/cart"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.cart }),
  });
}

/* ------------------------------- account -------------------------------- */

export function useProfile(enabled: boolean) {
  return useQuery({
    queryKey: keys.profile,
    queryFn: () =>
      api.get<{ user: User & { createdAt: string; lastLoginAt: string } }>("/account/me"),
    select: (data) => data.user,
    enabled,
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<User, "username" | "email" | "firstName" | "lastName">>) =>
      api.patch("/account/me", {
        username: patch.username,
        email: patch.email,
        first_name: patch.firstName,
        last_name: patch.lastName,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.profile }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post("/account/me/password", input),
  });
}

export function useAddresses(enabled: boolean) {
  return useQuery({
    queryKey: keys.addresses,
    queryFn: () => api.get<{ addresses: Address[] }>("/account/me/addresses"),
    select: (data) => asArray<Address>(data?.addresses),
    enabled,
  });
}

export type AddressInput = Omit<Address, "addressId" | "createdAt" | "effectiveDate"> &
  Partial<Pick<Address, "effectiveDate">>;

export function useCreateAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddressInput) =>
      api.post<{ address: Address }>("/account/me/addresses", toAddressPayload(input)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.addresses }),
  });
}

export function useUpdateAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ addressId, ...input }: AddressInput & { addressId: string }) =>
      api.patch<{ address: Address }>(
        `/account/me/addresses/${addressId}`,
        toAddressPayload(input),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.addresses }),
  });
}

export function useDeleteAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (addressId: string) => api.delete(`/account/me/addresses/${addressId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.addresses }),
  });
}

export function useSetDefaultAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (addressId: string) => api.post(`/account/me/addresses/${addressId}/default`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.addresses }),
  });
}

/** The API speaks snake_case; the UI speaks camelCase. Converted in one place. */
function toAddressPayload(input: Partial<AddressInput>) {
  return {
    address_type: input.addressType,
    recipient_name: input.recipientName,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2 || null,
    city: input.city,
    state: input.state || null,
    country: input.country,
    zip: input.zip,
    phone: input.phone || null,
    is_default: input.isDefault,
  };
}

/* -------------------------------- orders -------------------------------- */

export function useOrders(
  params: { page?: number; pageSize?: number; status?: string },
  enabled: boolean,
) {
  return useQuery({
    queryKey: keys.orders(params),
    queryFn: () => api.get<Paginated<OrderSummary>>("/orders", { query: params }),
    select: (data) => normalisePage<OrderSummary>(data),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useOrder(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.order(orderId ?? ""),
    queryFn: () => api.get<{ order: Order }>(`/orders/${orderId}`),
    select: (data): Order => ({
      ...((data?.order ?? {}) as Order),
      items: asArray<OrderItem>(data?.order?.items),
      timeline: asArray<OrderEvent>(data?.order?.timeline),
    }),
    enabled: Boolean(orderId),
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason?: string }) =>
      api.post(`/orders/${orderId}/cancel`, { reason: reason ?? null }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: keys.order(variables.orderId) });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/* ------------------------------- checkout ------------------------------- */

export function useCheckoutPreview(shippingAddressId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.checkoutPreview(shippingAddressId),
    queryFn: () =>
      api.get<CheckoutPreview>("/checkout/preview", {
        query: shippingAddressId ? { shippingAddressId } : undefined,
      }),
    select: (data): CheckoutPreview => ({
      ...((data ?? {}) as CheckoutPreview),
      items: asArray<CartItem>(data?.items),
      unavailable: asArray<UnavailableItem>(data?.unavailable),
    }),
    enabled,
    // Prices must be current at the point of purchase.
    staleTime: 0,
    retry: false,
  });
}

export interface PlaceOrderInput {
  shippingAddressId: string;
  paymentMethod: "card" | "paypal" | "sepa" | "invoice";
  paymentToken: string;
  cardLast4?: string | null;
  cardBrand?: string | null;
  shippingMethod?: "standard" | "express" | "overnight";
  expectedTotalCents: number;
  /** Generated once per checkout attempt and reused across retries. */
  idempotencyKey: string;
}

export function usePlaceOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: PlaceOrderInput) =>
      api.post<{ order: PlacedOrder }>("/checkout/orders", body, { idempotencyKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.cart });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/* -------------------------------- reviews ------------------------------- */

export function useReviews(
  productId: string | undefined,
  params: { page?: number; pageSize?: number; sort?: string },
) {
  return useQuery({
    queryKey: keys.reviews(productId ?? "", params),
    queryFn: () => api.get<ReviewsResponse>(`/reviews/product/${productId}`, { query: params }),
    select: (data): ReviewsResponse => ({
      ...normalisePage<Review>(data),
      summary: {
        average: data?.summary?.average ?? 0,
        total: data?.summary?.total ?? 0,
        histogram: data?.summary?.histogram ?? {},
      },
    }),
    enabled: Boolean(productId),
    placeholderData: (previous) => previous,
  });
}

export function useCreateReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { productId: string; rating: number; title?: string; body: string }) =>
      api.post("/reviews", input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["reviews", variables.productId] });
      queryClient.invalidateQueries({ queryKey: keys.product(variables.productId) });
    },
  });
}

export function useDeleteReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) => api.delete(`/reviews/${reviewId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }),
  });
}

/* ---------------------------- recommendations --------------------------- */

export function useRecommendations(kind: "for-me" | "trending", limit = 8) {
  return useQuery({
    queryKey: keys.recommendations(kind),
    queryFn: () =>
      api.get<{ recommendations: Recommendation[]; strategy: string }>(`/recommendations/${kind}`, {
        query: { limit },
      }),
    staleTime: 5 * 60_000,
  });
}

export function useRelatedProducts(productId: string | undefined, limit = 6) {
  return useQuery({
    queryKey: keys.recommendations("related", productId),
    queryFn: () =>
      api.get<{ recommendations: Recommendation[]; strategy: string }>(
        `/recommendations/related/${productId}`,
        { query: { limit } },
      ),
    select: (data) => ({
      recommendations: asArray<Recommendation>(data?.recommendations),
      strategy: data?.strategy ?? "unknown",
    }),
    enabled: Boolean(productId),
    staleTime: 5 * 60_000,
  });
}
