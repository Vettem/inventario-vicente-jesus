import {
  numberValue,
  rowId,
  stringValue,
  type DbRow,
  type ProductView,
} from './schema';

export type OrderStatus =
  | 'pending'
  | 'preparing'
  | 'ready'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type PaymentStatus = 'pending' | 'paid';
export type ShippingType = 'domicilio' | 'sucursal';

export type OrderView = {
  id: string;
  organizationId: string;
  productId: string;
  productName: string;
  createdBy: string;
  quantity: number;
  baseUnitPrice: number;
  baseContents: string;
  extraQuantity: number;
  extraUnitPrice: number;
  extraDetails: string;
  shippingCost: number;
  totalAmount: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  shippingType: ShippingType;
  shippingAddress: string;
  shippingCommune: string;
  shippingRegion: string;
  blueExpressBranch: string;
  trackingNumber: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  notes: string;
  createdAt: unknown;
  updatedAt: unknown;
  raw: DbRow;
};

export type OrderInput = {
  productId: string;
  quantity: number;
  baseUnitPrice: number;
  baseContents: string;
  extraQuantity: number;
  extraUnitPrice: number;
  extraDetails: string;
  shippingCost: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  shippingType: ShippingType;
  shippingAddress: string;
  shippingCommune: string;
  shippingRegion: string;
  blueExpressBranch: string;
  trackingNumber: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  notes: string;
};

export const orderStatusOptions: Array<{ value: OrderStatus; label: string }> = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'preparing', label: 'En preparacion' },
  { value: 'ready', label: 'Listo para enviar' },
  { value: 'shipped', label: 'Enviado' },
  { value: 'delivered', label: 'Entregado' },
  { value: 'cancelled', label: 'Cancelado' },
];

export const paymentStatusOptions: Array<{ value: PaymentStatus; label: string }> = [
  { value: 'pending', label: 'Pago pendiente' },
  { value: 'paid', label: 'Pagado' },
];

const validOrderStatuses = new Set<OrderStatus>(
  orderStatusOptions.map((option) => option.value),
);
const validPaymentStatuses = new Set<PaymentStatus>(
  paymentStatusOptions.map((option) => option.value),
);

function nullableText(row: DbRow, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? '' : String(value);
}

function orderStatusFromRow(row: DbRow): OrderStatus {
  const value = stringValue(row, ['order_status']) as OrderStatus;
  return validOrderStatuses.has(value) ? value : 'pending';
}

function paymentStatusFromRow(row: DbRow): PaymentStatus {
  const value = stringValue(row, ['payment_status']) as PaymentStatus;
  return validPaymentStatuses.has(value) ? value : 'pending';
}

function shippingTypeFromRow(row: DbRow): ShippingType {
  return stringValue(row, ['shipping_type']) === 'sucursal' ? 'sucursal' : 'domicilio';
}

export function orderFromRow(row: DbRow, products: ProductView[]): OrderView {
  const productId = stringValue(row, ['product_id']);
  const product = products.find((item) => item.id === productId);

  return {
    id: rowId(row),
    organizationId: stringValue(row, ['organization_id']),
    productId,
    productName: product?.name ?? 'Producto no disponible',
    createdBy: stringValue(row, ['created_by']),
    quantity: numberValue(row, ['quantity'], 1),
    baseUnitPrice: numberValue(row, ['base_unit_price']),
    baseContents: nullableText(row, 'base_contents'),
    extraQuantity: numberValue(row, ['extra_quantity']),
    extraUnitPrice: numberValue(row, ['extra_unit_price']),
    extraDetails: nullableText(row, 'extra_details'),
    shippingCost: numberValue(row, ['shipping_cost']),
    totalAmount: numberValue(row, ['total_amount']),
    customerName: stringValue(row, ['customer_name'], 'Cliente sin nombre'),
    customerPhone: nullableText(row, 'customer_phone'),
    customerEmail: nullableText(row, 'customer_email'),
    shippingType: shippingTypeFromRow(row),
    shippingAddress: nullableText(row, 'shipping_address'),
    shippingCommune: nullableText(row, 'shipping_commune'),
    shippingRegion: nullableText(row, 'shipping_region'),
    blueExpressBranch: nullableText(row, 'blue_express_branch'),
    trackingNumber: nullableText(row, 'tracking_number'),
    orderStatus: orderStatusFromRow(row),
    paymentStatus: paymentStatusFromRow(row),
    notes: nullableText(row, 'notes'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raw: row,
  };
}

export function calculateOrderTotals(input: {
  quantity: number;
  baseUnitPrice: number;
  extraQuantity: number;
  extraUnitPrice: number;
  shippingCost: number;
}) {
  const baseTotal = Math.max(0, input.quantity) * Math.max(0, input.baseUnitPrice);
  const extrasTotal = Math.max(0, input.extraQuantity) * Math.max(0, input.extraUnitPrice);
  const shippingTotal = Math.max(0, input.shippingCost);

  return {
    baseTotal,
    extrasTotal,
    shippingTotal,
    totalAmount: baseTotal + extrasTotal + shippingTotal,
  };
}

export function orderInputToRow(input: OrderInput, includeProduct = true): DbRow {
  const row: DbRow = {
    quantity: input.quantity,
    base_unit_price: input.baseUnitPrice,
    base_contents: input.baseContents || null,
    extra_quantity: input.extraQuantity,
    extra_unit_price: input.extraUnitPrice,
    extra_details: input.extraDetails || null,
    shipping_cost: input.shippingCost,
    customer_name: input.customerName,
    customer_phone: input.customerPhone || null,
    customer_email: input.customerEmail || null,
    shipping_type: input.shippingType,
    shipping_address: input.shippingAddress || null,
    shipping_commune: input.shippingCommune || null,
    shipping_region: input.shippingRegion || null,
    blue_express_branch: input.blueExpressBranch || null,
    tracking_number: input.trackingNumber || null,
    order_status: input.orderStatus,
    payment_status: input.paymentStatus,
    notes: input.notes || null,
  };

  if (includeProduct) row.product_id = input.productId;
  return row;
}

export function getOrderStatusLabel(status: OrderStatus) {
  return orderStatusOptions.find((option) => option.value === status)?.label ?? status;
}

export function getPaymentStatusLabel(status: PaymentStatus) {
  return paymentStatusOptions.find((option) => option.value === status)?.label ?? status;
}
