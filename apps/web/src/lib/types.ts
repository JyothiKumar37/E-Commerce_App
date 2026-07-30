/** Shapes returned by the API gateway. Kept in one place so a backend
 *  contract change surfaces as a compile error rather than a runtime undefined. */

export type Role = "customer" | "admin";

export interface User {
  userId: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
}

export interface Product {
  productId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  brand: string | null;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  attributes: Record<string, string | number | boolean>;
  ratingAvg: number;
  ratingCount: number;
  available?: number;
  inStock: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Facet {
  value: string;
  count: number;
}

export interface SearchResponse {
  items: Product[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  facets: {
    categories: Facet[];
    brands: Facet[];
    price: { minCents: number; maxCents: number } | null;
  };
  /** True when Elasticsearch was unreachable and results came from Postgres. */
  degraded: boolean;
}

export interface CartItem {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  unitPriceCents: number;
  currency: string;
  quantity: number;
  available: number;
  quantityAdjusted: boolean;
  lineTotalCents: number;
  addedAt: string;
}

export interface UnavailableItem {
  productId: string;
  name?: string;
  reason: "unavailable" | "out_of_stock";
  quantity: number;
}

export interface Cart {
  items: CartItem[];
  unavailable: UnavailableItem[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  itemCount: number;
  updatedAt: string | null;
}

export interface Address {
  addressId: string;
  addressType: "home" | "work" | "billing" | "shipping" | "other";
  recipientName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string | null;
  country: string;
  zip: string;
  phone: string | null;
  isDefault: boolean;
  effectiveDate: string;
  createdAt: string;
}

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded"
  | "failed";

export interface OrderItem {
  orderItemId: string;
  productId: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
  totalCents: number;
}

export interface OrderEvent {
  status: string;
  note: string | null;
  actor: string;
  at: string;
}

export interface Shipment {
  shipmentId: string;
  carrier: string;
  serviceLevel: "standard" | "express" | "overnight";
  trackingNumber: string | null;
  status: string;
  estimatedDelivery: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

export interface Order {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  shippingAddress: Address;
  placedAt: string;
  cancelledAt: string | null;
  items: OrderItem[];
  timeline: OrderEvent[];
  shipment: Shipment | null;
}

export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  itemCount: number;
  items: { name: string; imageUrl: string | null; quantity: number }[];
  placedAt: string;
}

export interface Review {
  reviewId: string;
  productId: string;
  rating: number;
  title: string | null;
  body: string;
  isVerifiedPurchase: boolean;
  helpfulCount: number;
  createdAt: string;
  updatedAt: string;
  author: { username: string; displayName: string };
  isMine: boolean;
  productName?: string;
}

export interface ReviewsResponse {
  items: Review[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  summary: {
    average: number;
    total: number;
    histogram: Record<string, number>;
  };
}

export interface Recommendation extends Product {
  reason?: string;
  score?: number;
}

export interface CheckoutTotals {
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

export interface CheckoutPreview {
  items: CartItem[];
  unavailable: UnavailableItem[];
  totals: CheckoutTotals;
  currency: string;
  shippingAddress: Address | null;
  taxRate: number;
  freeShippingThresholdCents: number;
}

export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  totals: CheckoutTotals;
  currency: string;
  payment: { paymentId: string; status: string };
  shipment: Shipment | null;
  items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
  placedAt: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}
