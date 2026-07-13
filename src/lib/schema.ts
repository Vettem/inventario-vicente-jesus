import type { AuthError, PostgrestError, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type DbRow = Record<string, unknown>;

export type MemberView = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  raw: DbRow;
};

export type ProductView = {
  id: string;
  name: string;
  sku: string;
  stock: number;
  costPrice: number;
  salePrice: number;
  lowStockThreshold: number;
  raw: DbRow;
};

export type SaleView = {
  id: string;
  productId: string;
  productName: string;
  sellerId: string;
  sellerName: string;
  quantity: number;
  total: number;
  grossProfit: number;
  createdAt: unknown;
  raw: DbRow;
};

export type MovementView = {
  id: string;
  productId: string;
  productName: string;
  type: string;
  quantity: number;
  note: string;
  createdAt: unknown;
  raw: DbRow;
};

type RpcArgs = Record<string, string | number | null>;

const PRODUCT_NAME_KEYS = ['name', 'nombre', 'title', 'titulo'];
const PRODUCT_SKU_KEYS = ['sku', 'code', 'codigo', 'barcode'];
const PRODUCT_STOCK_KEYS = [
  'stock',
  'available_stock',
  'current_stock',
  'quantity',
  'cantidad',
];
const PRODUCT_COST_KEYS = [
  'cost_price',
  'purchase_price',
  'unit_cost',
  'precio_costo',
  'costo',
];
const PRODUCT_SALE_KEYS = [
  'sale_price',
  'selling_price',
  'unit_price',
  'price',
  'precio_venta',
  'precio',
];

export function rowId(row: DbRow): string {
  return stringValue(row, ['id', 'uuid', 'product_id', 'member_id']) || '';
}

export function stringValue(row: DbRow, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return String(value);
    }
  }

  return fallback;
}

export function numberValue(row: DbRow, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return fallback;
}

function booleanValue(row: DbRow, keys: string[], fallback = true): boolean {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (['true', 'activo', 'active', '1'].includes(value.toLowerCase())) {
        return true;
      }

      if (['false', 'inactivo', 'inactive', '0'].includes(value.toLowerCase())) {
        return false;
      }
    }
  }

  return fallback;
}

export function memberFromRow(row: DbRow): MemberView {
  const firstName = stringValue(row, ['first_name', 'nombre']);
  const lastName = stringValue(row, ['last_name', 'apellido']);
  const fullName = stringValue(row, ['name', 'full_name', 'display_name']);
  const email = stringValue(row, ['email', 'correo']);

  return {
    id: rowId(row),
    name: fullName || [firstName, lastName].filter(Boolean).join(' ') || email,
    email,
    isActive: booleanValue(row, ['active', 'is_active', 'enabled', 'activo']),
    raw: row,
  };
}

export function productFromRow(row: DbRow): ProductView {
  return {
    id: rowId(row),
    name: stringValue(row, PRODUCT_NAME_KEYS, 'Producto sin nombre'),
    sku: stringValue(row, PRODUCT_SKU_KEYS),
    stock: numberValue(row, PRODUCT_STOCK_KEYS),
    costPrice: numberValue(row, PRODUCT_COST_KEYS),
    salePrice: numberValue(row, PRODUCT_SALE_KEYS),
    lowStockThreshold: numberValue(
      row,
      ['low_stock_threshold', 'minimum_stock', 'min_stock', 'stock_minimo'],
      5,
    ),
    raw: row,
  };
}

export function saleFromRow(
  row: DbRow,
  products: ProductView[],
  members: MemberView[],
): SaleView {
  const productId = stringValue(row, ['product_id', 'product', 'producto_id']);
  const sellerId = stringValue(row, [
    'seller_id',
    'member_id',
    'user_id',
    'vendedor_id',
  ]);
  const product = products.find((item) => item.id === productId);
  const seller = members.find((item) => item.id === sellerId);
  const quantity = numberValue(row, ['quantity', 'qty', 'cantidad']);
  const unitPrice = numberValue(row, PRODUCT_SALE_KEYS);
  const total = numberValue(row, ['total', 'total_amount', 'monto_total'], quantity * unitPrice);
  const grossProfit = numberValue(row, [
    'gross_profit',
    'profit',
    'ganancia_bruta',
    'gross_margin',
  ]);

  return {
    id: rowId(row),
    productId,
    productName: stringValue(row, ['product_name', 'producto'], product?.name ?? 'Producto'),
    sellerId,
    sellerName: stringValue(row, ['seller_name', 'vendedor'], seller?.name ?? 'Vendedor'),
    quantity,
    total,
    grossProfit,
    createdAt: row.created_at ?? row.sold_at ?? row.date ?? row.fecha,
    raw: row,
  };
}

export function movementFromRow(
  row: DbRow,
  products: ProductView[],
): MovementView {
  const productId = stringValue(row, ['product_id', 'product', 'producto_id']);
  const product = products.find((item) => item.id === productId);

  return {
    id: rowId(row),
    productId,
    productName: stringValue(row, ['product_name', 'producto'], product?.name ?? 'Producto'),
    type: stringValue(row, ['type', 'movement_type', 'kind', 'tipo'], 'movimiento'),
    quantity: numberValue(row, ['quantity', 'qty', 'cantidad']),
    note: stringValue(row, ['notes', 'note', 'reason', 'motivo', 'detalle']),
    createdAt: row.created_at ?? row.date ?? row.fecha,
    raw: row,
  };
}

export function memberMatchesUser(member: MemberView, user: User): boolean {
  const raw = member.raw;
  const identifiers = [
    stringValue(raw, ['user_id', 'auth_user_id', 'profile_id']),
    member.id,
  ].filter(Boolean);

  if (identifiers.includes(user.id)) return true;

  const email = member.email.toLowerCase();
  return Boolean(email && email === user.email?.toLowerCase());
}

export function compareByDateDesc(a: { createdAt: unknown }, b: { createdAt: unknown }) {
  const first = new Date(String(a.createdAt ?? 0)).getTime();
  const second = new Date(String(b.createdAt ?? 0)).getTime();
  return (Number.isFinite(second) ? second : 0) - (Number.isFinite(first) ? first : 0);
}

export function getReadableError(error: unknown): string {
  if (!error) return 'Ocurrio un error inesperado.';
  const message =
    typeof error === 'object' && 'message' in error
      ? String((error as AuthError | PostgrestError).message)
      : String(error);

  if (message.includes('Invalid login credentials')) {
    return 'Correo o contrasena incorrectos.';
  }

  if (message.includes('Email not confirmed')) {
    return 'Debes confirmar tu correo antes de iniciar sesion.';
  }

  if (message.includes('JWT')) {
    return 'Tu sesion expiro. Inicia sesion nuevamente.';
  }

  if (message.includes('violates row-level security')) {
    return 'No tienes permisos para realizar esta accion en Supabase.';
  }

  return message || 'Ocurrio un error inesperado.';
}

async function callInventoryRpc(functionName: string, args: RpcArgs) {
  const { error } = await supabase.rpc(functionName, args);
  if (error) throw error;
}

export async function registerStockEntry(params: {
  productId: string;
  quantity: number;
  unitCost: number | null;
  notes: string;
}) {
  return callInventoryRpc('register_stock_entry', {
    p_product_id: params.productId,
    p_quantity: params.quantity,
    p_unit_cost: params.unitCost,
    p_movement_type: 'purchase',
    p_notes: params.notes || null,
  });
}

export async function registerSale(params: {
  productId: string;
  quantity: number;
  unitPrice: number;
  paymentMethod: string;
  notes: string;
}) {
  return callInventoryRpc('register_sale', {
    p_product_id: params.productId,
    p_quantity: params.quantity,
    p_unit_price: params.unitPrice,
    p_payment_method: params.paymentMethod || 'Transferencia',
    p_notes: params.notes || null,
  });
}

export async function registerStockOutput(params: {
  productId: string;
  quantity: number;
  movementType: string;
  notes: string;
}) {
  return callInventoryRpc('register_stock_output', {
    p_product_id: params.productId,
    p_quantity: params.quantity,
    p_movement_type: params.movementType,
    p_notes: params.notes || null,
  });
}
