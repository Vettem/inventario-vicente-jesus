import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  MapPin,
  PackagePlus,
  Pencil,
  Search,
  ShoppingBag,
  Truck,
  UserRound,
} from 'lucide-react';
import { formatClp, formatDate, formatUnits } from '../../lib/format';
import {
  calculateOrderTotals,
  getOrderStatusLabel,
  getPaymentStatusLabel,
  orderStatusOptions,
  paymentStatusOptions,
  type OrderInput,
  type OrderStatus,
  type OrderView,
  type PaymentStatus,
  type ShippingType,
} from '../../lib/orders';
import type { ProductView } from '../../lib/schema';

type OrdersPanelProps = {
  loading: boolean;
  orders: OrderView[];
  products: ProductView[];
  onCreate: (input: OrderInput) => Promise<boolean>;
  onUpdate: (orderId: string, input: OrderInput) => Promise<boolean>;
};

type PanelMode = 'list' | 'create' | 'detail' | 'edit';

type OrderFormState = {
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

const emptyOrderForm: OrderFormState = {
  productId: '',
  quantity: 1,
  baseUnitPrice: 0,
  baseContents: '',
  extraQuantity: 0,
  extraUnitPrice: 0,
  extraDetails: '',
  shippingCost: 0,
  customerName: '',
  customerPhone: '',
  customerEmail: '',
  shippingType: 'domicilio',
  shippingAddress: '',
  shippingCommune: '',
  shippingRegion: '',
  blueExpressBranch: '',
  trackingNumber: '',
  orderStatus: 'pending',
  paymentStatus: 'pending',
  notes: '',
};

function formFromOrder(order: OrderView): OrderFormState {
  return {
    productId: order.productId,
    quantity: order.quantity,
    baseUnitPrice: order.baseUnitPrice,
    baseContents: order.baseContents,
    extraQuantity: order.extraQuantity,
    extraUnitPrice: order.extraUnitPrice,
    extraDetails: order.extraDetails,
    shippingCost: order.shippingCost,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail,
    shippingType: order.shippingType,
    shippingAddress: order.shippingAddress,
    shippingCommune: order.shippingCommune,
    shippingRegion: order.shippingRegion,
    blueExpressBranch: order.blueExpressBranch,
    trackingNumber: order.trackingNumber,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    notes: order.notes,
  };
}

function normalizeOrderInput(form: OrderFormState, showExtras: boolean): OrderInput {
  return {
    ...form,
    quantity: Math.max(1, form.quantity),
    baseUnitPrice: Math.max(0, form.baseUnitPrice),
    baseContents: form.baseContents.trim(),
    extraQuantity: showExtras ? Math.max(0, form.extraQuantity) : 0,
    extraUnitPrice: showExtras ? Math.max(0, form.extraUnitPrice) : 0,
    extraDetails: showExtras ? form.extraDetails.trim() : '',
    shippingCost: Math.max(0, form.shippingCost),
    customerName: form.customerName.trim(),
    customerPhone: form.customerPhone.trim(),
    customerEmail: form.customerEmail.trim(),
    shippingAddress: form.shippingType === 'domicilio' ? form.shippingAddress.trim() : '',
    shippingCommune: form.shippingCommune.trim(),
    shippingRegion: form.shippingRegion.trim(),
    blueExpressBranch:
      form.shippingType === 'sucursal' ? form.blueExpressBranch.trim() : '',
    trackingNumber: form.trackingNumber.trim(),
    notes: form.notes.trim(),
  };
}

export function OrdersPanel({
  loading,
  orders,
  products,
  onCreate,
  onUpdate,
}: OrdersPanelProps) {
  const [mode, setMode] = useState<PanelMode>('list');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | OrderStatus>('all');
  const selectedOrder = orders.find((order) => order.id === selectedOrderId) ?? null;

  const filteredOrders = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('es-CL');

    return orders.filter((order) => {
      const matchesStatus = statusFilter === 'all' || order.orderStatus === statusFilter;
      const searchableText = [
        order.customerName,
        order.customerPhone,
        order.customerEmail,
      ].join(' ').toLocaleLowerCase('es-CL');

      return matchesStatus && (!normalizedSearch || searchableText.includes(normalizedSearch));
    });
  }, [orders, search, statusFilter]);

  function openDetail(orderId: string) {
    setSelectedOrderId(orderId);
    setMode('detail');
  }

  function returnToList() {
    setMode('list');
    setSelectedOrderId(null);
  }

  if (mode === 'create') {
    return (
      <OrderForm
        onCancel={returnToList}
        onSubmit={onCreate}
        products={products}
      />
    );
  }

  if (mode === 'edit' && selectedOrder) {
    return (
      <OrderForm
        onCancel={() => setMode('detail')}
        onSubmit={(input) => onUpdate(selectedOrder.id, input)}
        order={selectedOrder}
        products={products}
      />
    );
  }

  if (mode === 'detail' && selectedOrder) {
    return (
      <OrderDetail
        onBack={returnToList}
        onEdit={() => setMode('edit')}
        order={selectedOrder}
      />
    );
  }

  return (
    <section className="page-stack orders-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Pedidos</p>
          <h1>Gestion de pedidos</h1>
          <p>Registra clientes, extras, despacho y seguimiento sin alterar el inventario.</p>
        </div>
        <button
          className="primary-button order-primary-action"
          disabled={!products.length}
          onClick={() => setMode('create')}
          type="button"
        >
          <PackagePlus aria-hidden="true" size={18} />
          Nuevo pedido
        </button>
      </header>

      {!products.length && !loading && (
        <div className="alert info">
          Crea al menos un producto antes de registrar pedidos.
        </div>
      )}

      <section className="panel orders-list-panel">
        <div className="orders-toolbar">
          <label className="order-search-field">
            <span>Buscar cliente</span>
            <div className="search-input-shell">
              <Search aria-hidden="true" size={18} />
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Nombre, telefono o correo"
                type="search"
                value={search}
              />
            </div>
          </label>
          <label>
            <span>Estado</span>
            <select
              onChange={(event) =>
                setStatusFilter(event.target.value as 'all' | OrderStatus)
              }
              value={statusFilter}
            >
              <option value="all">Todos</option>
              {orderStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loading && !orders.length ? (
          <div className="loading-state">
            <ClipboardList aria-hidden="true" size={22} />
            <p>Cargando pedidos...</p>
          </div>
        ) : (
          <div className="order-card-grid">
            {filteredOrders.map((order) => (
              <OrderCard key={order.id} onOpen={() => openDetail(order.id)} order={order} />
            ))}
            {!filteredOrders.length && (
              <div className="empty-state">
                <ShoppingBag aria-hidden="true" size={24} />
                <p>No hay pedidos que coincidan con la busqueda.</p>
              </div>
            )}
          </div>
        )}
      </section>
    </section>
  );
}

function OrderCard({ order, onOpen }: { order: OrderView; onOpen: () => void }) {
  return (
    <button className="order-card" onClick={onOpen} type="button">
      <div className="order-card-topline">
        <div>
          <strong>{order.customerName}</strong>
          <span>{order.productName}</span>
        </div>
        <OrderStatusBadge status={order.orderStatus} />
      </div>
      <div className="order-card-summary">
        <span>
          <strong>{formatClp(order.totalAmount)}</strong>
          Total
        </span>
        <span>
          <strong>{order.shippingType === 'domicilio' ? 'Domicilio' : 'Sucursal'}</strong>
          Despacho
        </span>
        <span>
          <strong>{formatDate(order.createdAt)}</strong>
          Fecha
        </span>
      </div>
      <div className="order-card-footer">
        <PaymentStatusBadge status={order.paymentStatus} />
        <span>Ver detalle</span>
      </div>
    </button>
  );
}

function OrderForm({
  onCancel,
  onSubmit,
  order,
  products,
}: {
  onCancel: () => void;
  onSubmit: (input: OrderInput) => Promise<boolean>;
  order?: OrderView;
  products: ProductView[];
}) {
  const [form, setForm] = useState<OrderFormState>(() =>
    order ? formFromOrder(order) : emptyOrderForm,
  );
  const [saving, setSaving] = useState(false);
  const selectedProduct = products.find((product) => product.id === form.productId);
  const showExtras = Boolean(
    selectedProduct?.allowCustomExtras ||
    (order && (order.extraQuantity > 0 || order.extraUnitPrice > 0 || order.extraDetails)),
  );
  const totals = calculateOrderTotals(form);

  function updateField<Key extends keyof OrderFormState>(
    key: Key,
    value: OrderFormState[Key],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function selectProduct(productId: string) {
    const product = products.find((item) => item.id === productId);
    setForm((current) => ({
      ...current,
      productId,
      baseUnitPrice: product?.salePrice ?? 0,
      baseContents: product?.defaultContents ?? '',
      extraQuantity: 0,
      extraUnitPrice: product?.allowCustomExtras ? product.extraUnitPrice : 0,
      extraDetails: '',
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const saved = await onSubmit(normalizeOrderInput(form, showExtras));

    if (saved) {
      onCancel();
    } else {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack orders-page">
      <header className="page-header order-subpage-header">
        <div>
          <p className="eyebrow">Pedidos</p>
          <h1>{order ? 'Editar pedido' : 'Nuevo pedido'}</h1>
          <p>Los precios y contenidos quedan guardados como snapshot historico.</p>
        </div>
        <button className="ghost-button order-back-button" onClick={onCancel} type="button">
          <ArrowLeft aria-hidden="true" size={18} />
          Volver
        </button>
      </header>

      <form className="order-form-layout" onSubmit={handleSubmit}>
        <div className="order-form-sections">
          <OrderFormSection icon={<ShoppingBag size={19} />} title="Producto">
            <OrderField label="Producto">
              <select
                disabled={Boolean(order)}
                onChange={(event) => selectProduct(event.target.value)}
                required
                value={form.productId}
              >
                <option value="">Seleccionar producto</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} - {formatClp(product.salePrice)}
                  </option>
                ))}
              </select>
            </OrderField>
            {form.productId && (
              <div className="order-snapshot-copy">
                <span>Contenido incluido</span>
                <p>{form.baseContents || 'Sin contenido base configurado.'}</p>
              </div>
            )}
            <div className="two-columns">
              <OrderField label="Cantidad">
                <input
                  inputMode="numeric"
                  min="1"
                  onChange={(event) => updateField('quantity', Number(event.target.value))}
                  required
                  step="1"
                  type="number"
                  value={form.quantity}
                />
              </OrderField>
              <OrderField label="Precio base unitario">
                <input
                  inputMode="numeric"
                  min="0"
                  onChange={(event) => updateField('baseUnitPrice', Number(event.target.value))}
                  required
                  step="1"
                  type="number"
                  value={form.baseUnitPrice}
                />
              </OrderField>
            </div>
          </OrderFormSection>

          {showExtras && (
            <OrderFormSection icon={<PackagePlus size={19} />} title="Extras personalizados">
              <div className="two-columns">
                <OrderField label="Cantidad de extras">
                  <input
                    inputMode="numeric"
                    min="0"
                    onChange={(event) => updateField('extraQuantity', Number(event.target.value))}
                    step="1"
                    type="number"
                    value={form.extraQuantity}
                  />
                </OrderField>
                <OrderField label="Precio por extra">
                  <input
                    inputMode="numeric"
                    min="0"
                    onChange={(event) => updateField('extraUnitPrice', Number(event.target.value))}
                    step="1"
                    type="number"
                    value={form.extraUnitPrice}
                  />
                </OrderField>
              </div>
              <OrderField label="Detalle de extras">
                <textarea
                  onChange={(event) => updateField('extraDetails', event.target.value)}
                  placeholder="Ej: 2 leches, 1 pan, 1 arroz, 1 manzana y 1 jugo"
                  required={form.extraQuantity > 0}
                  rows={3}
                  value={form.extraDetails}
                />
              </OrderField>
              <p className="order-inline-total">
                Extras: {formatUnits(form.extraQuantity)} x {formatClp(form.extraUnitPrice)} ={' '}
                <strong>{formatClp(totals.extrasTotal)}</strong>
              </p>
            </OrderFormSection>
          )}

          <OrderFormSection icon={<UserRound size={19} />} title="Datos del cliente">
            <OrderField label="Nombre">
              <input
                onChange={(event) => updateField('customerName', event.target.value)}
                required
                value={form.customerName}
              />
            </OrderField>
            <div className="two-columns">
              <OrderField label="Telefono">
                <input
                  inputMode="tel"
                  onChange={(event) => updateField('customerPhone', event.target.value)}
                  type="tel"
                  value={form.customerPhone}
                />
              </OrderField>
              <OrderField label="Correo">
                <input
                  inputMode="email"
                  onChange={(event) => updateField('customerEmail', event.target.value)}
                  type="email"
                  value={form.customerEmail}
                />
              </OrderField>
            </div>
          </OrderFormSection>

          <OrderFormSection icon={<Truck size={19} />} title="Despacho">
            <OrderField label="Tipo de despacho">
              <select
                onChange={(event) =>
                  updateField('shippingType', event.target.value as ShippingType)
                }
                value={form.shippingType}
              >
                <option value="domicilio">Domicilio</option>
                <option value="sucursal">Sucursal Blue Express</option>
              </select>
            </OrderField>
            {form.shippingType === 'domicilio' ? (
              <OrderField label="Direccion">
                <input
                  onChange={(event) => updateField('shippingAddress', event.target.value)}
                  required
                  value={form.shippingAddress}
                />
              </OrderField>
            ) : (
              <OrderField label="Sucursal Blue Express">
                <input
                  onChange={(event) => updateField('blueExpressBranch', event.target.value)}
                  required
                  value={form.blueExpressBranch}
                />
              </OrderField>
            )}
            <div className="two-columns">
              <OrderField label="Comuna">
                <input
                  onChange={(event) => updateField('shippingCommune', event.target.value)}
                  value={form.shippingCommune}
                />
              </OrderField>
              <OrderField label="Region">
                <input
                  onChange={(event) => updateField('shippingRegion', event.target.value)}
                  value={form.shippingRegion}
                />
              </OrderField>
            </div>
            <OrderField label="Costo de envio">
              <input
                inputMode="numeric"
                min="0"
                onChange={(event) => updateField('shippingCost', Number(event.target.value))}
                step="1"
                type="number"
                value={form.shippingCost}
              />
            </OrderField>
            {order && (
              <OrderField label="Numero de seguimiento">
                <input
                  onChange={(event) => updateField('trackingNumber', event.target.value)}
                  value={form.trackingNumber}
                />
              </OrderField>
            )}
          </OrderFormSection>

          <OrderFormSection icon={<CheckCircle2 size={19} />} title="Estado y notas">
            <div className="two-columns">
              <OrderField label="Estado del pedido">
                <select
                  onChange={(event) =>
                    updateField('orderStatus', event.target.value as OrderStatus)
                  }
                  value={form.orderStatus}
                >
                  {orderStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </OrderField>
              <OrderField label="Estado del pago">
                <select
                  onChange={(event) =>
                    updateField('paymentStatus', event.target.value as PaymentStatus)
                  }
                  value={form.paymentStatus}
                >
                  {paymentStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </OrderField>
            </div>
            <OrderField label="Notas">
              <textarea
                onChange={(event) => updateField('notes', event.target.value)}
                placeholder="Indicaciones adicionales"
                rows={3}
                value={form.notes}
              />
            </OrderField>
          </OrderFormSection>
        </div>

        <OrderTotalSummary form={form} totals={totals} />

        <div className="order-form-actions">
          <button className="ghost-button" onClick={onCancel} type="button">
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={saving || !form.productId}
            type="submit"
          >
            {saving ? 'Guardando...' : order ? 'Guardar cambios' : 'Crear pedido'}
          </button>
        </div>
      </form>
    </section>
  );
}

function OrderTotalSummary({
  form,
  totals,
}: {
  form: OrderFormState;
  totals: ReturnType<typeof calculateOrderTotals>;
}) {
  return (
    <aside className="panel order-total-panel" aria-label="Resumen del pedido">
      <h2>Resumen</h2>
      <div>
        <span>Precio base ({formatUnits(form.quantity)})</span>
        <strong>{formatClp(totals.baseTotal)}</strong>
      </div>
      {totals.extrasTotal > 0 && (
        <div>
          <span>{formatUnits(form.extraQuantity)} extras</span>
          <strong>{formatClp(totals.extrasTotal)}</strong>
        </div>
      )}
      <div>
        <span>Despacho</span>
        <strong>{formatClp(totals.shippingTotal)}</strong>
      </div>
      <div className="order-grand-total">
        <span>Total</span>
        <strong>{formatClp(totals.totalAmount)}</strong>
      </div>
      <p>El total definitivo tambien se calcula automaticamente en la base de datos.</p>
    </aside>
  );
}

function OrderDetail({
  order,
  onBack,
  onEdit,
}: {
  order: OrderView;
  onBack: () => void;
  onEdit: () => void;
}) {
  const totals = calculateOrderTotals(order);
  const shippingDestination =
    order.shippingType === 'domicilio' ? order.shippingAddress : order.blueExpressBranch;

  return (
    <section className="page-stack orders-page">
      <header className="page-header order-subpage-header">
        <div>
          <p className="eyebrow">Detalle del pedido</p>
          <h1>{order.customerName}</h1>
          <p>{formatDate(order.createdAt)} · {order.productName}</p>
        </div>
        <div className="order-header-actions">
          <button className="ghost-button order-back-button" onClick={onBack} type="button">
            <ArrowLeft aria-hidden="true" size={18} />
            Volver
          </button>
          <button className="primary-button order-back-button" onClick={onEdit} type="button">
            <Pencil aria-hidden="true" size={17} />
            Editar
          </button>
        </div>
      </header>

      <div className="order-detail-grid">
        <DetailSection icon={<UserRound size={19} />} title="Datos del cliente">
          <DetailRow label="Nombre" value={order.customerName} />
          <DetailRow label="Telefono" value={order.customerPhone || 'No registrado'} />
          <DetailRow label="Correo" value={order.customerEmail || 'No registrado'} />
        </DetailSection>

        <DetailSection icon={<ShoppingBag size={19} />} title="Pedido">
          <DetailRow label="Producto" value={order.productName} />
          <DetailRow label="Contenido base" value={order.baseContents || 'Sin detalle'} />
          <DetailRow label="Cantidad" value={formatUnits(order.quantity)} />
          <DetailRow label="Precio base unitario" value={formatClp(order.baseUnitPrice)} />
        </DetailSection>

        <DetailSection icon={<PackagePlus size={19} />} title="Extras">
          <DetailRow label="Cantidad" value={formatUnits(order.extraQuantity)} />
          <DetailRow label="Precio unitario" value={formatClp(order.extraUnitPrice)} />
          <DetailRow label="Detalle" value={order.extraDetails || 'Sin extras'} />
        </DetailSection>

        <DetailSection icon={<MapPin size={19} />} title="Despacho">
          <DetailRow
            label="Modalidad"
            value={order.shippingType === 'domicilio' ? 'Domicilio' : 'Sucursal Blue Express'}
          />
          <DetailRow label="Destino" value={shippingDestination || 'No registrado'} />
          <DetailRow label="Comuna" value={order.shippingCommune || 'No registrada'} />
          <DetailRow label="Region" value={order.shippingRegion || 'No registrada'} />
          <DetailRow label="Seguimiento" value={order.trackingNumber || 'Sin seguimiento'} />
        </DetailSection>

        <DetailSection icon={<CheckCircle2 size={19} />} title="Estado">
          <DetailRow label="Pedido" value={getOrderStatusLabel(order.orderStatus)} />
          <DetailRow label="Pago" value={getPaymentStatusLabel(order.paymentStatus)} />
        </DetailSection>

        <DetailSection icon={<ClipboardList size={19} />} title="Totales">
          <DetailRow label="Base" value={formatClp(totals.baseTotal)} />
          <DetailRow label="Extras" value={formatClp(totals.extrasTotal)} />
          <DetailRow label="Envio" value={formatClp(totals.shippingTotal)} />
          <DetailRow label="Total" value={formatClp(order.totalAmount)} strong />
        </DetailSection>
      </div>

      <section className="panel order-notes-panel">
        <h2>Notas</h2>
        <p>{order.notes || 'Sin notas adicionales.'}</p>
      </section>
    </section>
  );
}

function OrderFormSection({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="panel order-form-section">
      <div className="order-section-heading">
        <span>{icon}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function DetailSection({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="panel order-detail-section">
      <div className="order-section-heading">
        <span>{icon}</span>
        <h2>{title}</h2>
      </div>
      <div className="order-detail-rows">{children}</div>
    </section>
  );
}

function OrderField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label>
      <span>{label}</span>
      {children}
    </label>
  );
}

function DetailRow({
  label,
  strong = false,
  value,
}: {
  label: string;
  strong?: boolean;
  value: string;
}) {
  return (
    <div className={strong ? 'order-detail-row strong' : 'order-detail-row'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`order-status-badge ${status}`}>
      {getOrderStatusLabel(status)}
    </span>
  );
}

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`payment-status-badge ${status}`}>
      {getPaymentStatusLabel(status)}
    </span>
  );
}
