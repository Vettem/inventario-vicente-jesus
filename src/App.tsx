import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PostgrestError, Session } from '@supabase/supabase-js';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import {
  compareByDateDesc,
  getReadableError,
  memberFromRow,
  memberMatchesUser,
  movementFromRow,
  productFromRow,
  registerSale,
  registerStockEntry,
  registerStockOutput,
  saleFromRow,
  type DbRow,
  type MemberView,
  type MovementView,
  type ProductView,
  type SaleView,
} from './lib/schema';
import { formatClp, formatDate, formatUnits } from './lib/format';

type Tab = 'resumen' | 'productos' | 'operaciones' | 'ventas' | 'historial';

type LoadState = {
  products: ProductView[];
  members: MemberView[];
  sales: SaleView[];
  movements: MovementView[];
};

type FormStatus = {
  loading: boolean;
  error: string;
  success: string;
};

const initialData: LoadState = {
  products: [],
  members: [],
  sales: [],
  movements: [],
};

const emptyStatus: FormStatus = {
  loading: false,
  error: '',
  success: '',
};

const paymentMethods = ['Transferencia', 'Efectivo', 'Débito', 'Crédito', 'Otro'];

function logSupabaseError(context: string, error: unknown) {
  const supabaseError = error as Partial<PostgrestError>;

  console.error(context, {
    message: supabaseError.message,
    details: supabaseError.details,
    hint: supabaseError.hint,
    code: supabaseError.code,
  });
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('resumen');
  const [member, setMember] = useState<MemberView | null>(null);
  const [data, setData] = useState<LoadState>(initialData);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [formStatus, setFormStatus] = useState<FormStatus>(emptyStatus);
  const [saleFormVersion, setSaleFormVersion] = useState(0);
  const activeSessionRef = useRef<Session | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);
  const loadCountRef = useRef(0);
  const authEventCountRef = useRef(0);

  const loadData = useCallback(async (currentSession: Session, reason: string) => {
    if (!currentSession.user) return;

    const loadNumber = loadCountRef.current + 1;
    loadCountRef.current = loadNumber;
    console.info(`[inventario] carga #${loadNumber} iniciada: ${reason}`);
    console.count('[inventario] loadData');

    setDataLoading(true);
    setDataError('');

    try {
      console.count('[inventario] query members');
      console.count('[inventario] query products');
      console.count('[inventario] query sales');
      console.count('[inventario] query inventory_movements');

      const [membersResult, productsResult, salesResult, movementsResult] =
        await Promise.all([
          supabase.from('members').select('*'),
          supabase.from('products').select('*'),
          supabase.from('sales').select('*'),
          supabase.from('inventory_movements').select('*'),
        ]);

      const firstError =
        membersResult.error ??
        productsResult.error ??
        salesResult.error ??
        movementsResult.error;

      if (firstError) throw firstError;

      const members = ((membersResult.data ?? []) as DbRow[]).map(memberFromRow);
      const activeMember = members.find(
        (item) => item.isActive && memberMatchesUser(item, currentSession.user),
      );

      if (!activeMember) {
        setMember(null);
        setData(initialData);
        setDataError(
          'Tu usuario inicio sesion, pero no aparece como miembro activo. Pide revisar la tabla members.',
        );
        return;
      }

      const products = ((productsResult.data ?? []) as DbRow[]).map(productFromRow);
      const sales = ((salesResult.data ?? []) as DbRow[])
        .map((row) => saleFromRow(row, products, members))
        .sort(compareByDateDesc);
      const movements = ((movementsResult.data ?? []) as DbRow[])
        .map((row) => movementFromRow(row, products))
        .sort(compareByDateDesc);

      setMember(activeMember);
      setData({ members, products, sales, movements });
      console.info(`[inventario] carga #${loadNumber} completada`);
    } catch (error) {
      console.error(`[inventario] carga #${loadNumber} fallo`, error);
      setDataError(getReadableError(error));
    } finally {
      setDataLoading(false);
    }
  }, []);

  const refreshData = useCallback(
    async (reason: string) => {
      const currentSession = activeSessionRef.current;
      if (!currentSession) {
        setDataError('No hay una sesion activa para actualizar los datos.');
        return;
      }

      await loadData(currentSession, reason);
    },
    [loadData],
  );

  useEffect(() => {
    let cancelled = false;

    const applySession = async (nextSession: Session | null, source: string) => {
      if (cancelled) return;

      authEventCountRef.current += 1;
      console.info(
        `[inventario] evento auth #${authEventCountRef.current}: ${source}`,
      );

      setSession(nextSession);
      activeSessionRef.current = nextSession;
      setAuthLoading(false);

      if (!nextSession) {
        loadedUserIdRef.current = null;
        setMember(null);
        setData(initialData);
        return;
      }

      if (loadedUserIdRef.current === nextSession.user.id) {
        console.info(`[inventario] carga inicial omitida: ${source} ya fue procesado`);
        return;
      }

      loadedUserIdRef.current = nextSession.user.id;
      await loadData(nextSession, `carga inicial desde ${source}`);
    };

    void supabase.auth.getSession().then(({ data: authData, error }) => {
      if (error) {
        setAuthError(getReadableError(error));
        setAuthLoading(false);
        return;
      }

      void applySession(authData.session, 'getSession');
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'TOKEN_REFRESHED' && nextSession) {
        setSession(nextSession);
        activeSessionRef.current = nextSession;
        return;
      }

      void applySession(nextSession, `onAuthStateChange:${event}`);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      console.info('[inventario] listener auth desmontado');
    };
  }, [loadData]);

  const summary = useMemo(() => {
    const availableUnits = data.products.reduce((sum, product) => sum + product.stock, 0);
    const inventoryCostValue = data.products.reduce(
      (sum, product) => sum + product.stock * product.costPrice,
      0,
    );
    const accumulatedSales = data.sales.reduce((sum, sale) => sum + sale.total, 0);
    const grossProfit = data.sales.reduce((sum, sale) => sum + sale.grossProfit, 0);
    const lowStockCount = data.products.filter(
      (product) => product.stock <= product.lowStockThreshold,
    ).length;

    return {
      availableUnits,
      inventoryCostValue,
      accumulatedSales,
      grossProfit,
      lowStockCount,
    };
  }, [data.products, data.sales]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError('');
    setLoginLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;
    } catch (error) {
      setAuthError(getReadableError(error));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    setAuthError('');
    const { error } = await supabase.auth.signOut();
    if (error) setAuthError(getReadableError(error));
  }

  async function handleCreateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const productForm = event.currentTarget;
    const user = activeSessionRef.current?.user;
    const form = new FormData(productForm);
    const name = String(form.get('name') ?? '').trim();
    const sku = String(form.get('sku') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const costPrice = Number(form.get('costPrice') ?? 0);
    const salePrice = Number(form.get('salePrice') ?? 0);
    const lowStockThreshold = Number(form.get('lowStockThreshold') ?? 0);

    if (!user) {
      setFormStatus({
        ...emptyStatus,
        error: 'No hay un usuario autenticado para crear el producto.',
      });
      return;
    }

    if (!name) {
      setFormStatus({ ...emptyStatus, error: 'Ingresa el nombre del producto.' });
      return;
    }

    setFormStatus({ ...emptyStatus, loading: true });

    try {
      const insert: DbRow = {
        name,
        sku: sku || null,
        description: description || null,
        stock: 0,
        cost_price: costPrice,
        sale_price: salePrice,
        low_stock_threshold: lowStockThreshold,
        active: true,
        created_by: user.id,
      };

      const { error } = await supabase.from('products').insert(insert);
      if (error) {
        console.error('[inventario] error Supabase al crear producto', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        throw error;
      }

      productForm.reset();
      setFormStatus({ ...emptyStatus, success: 'Producto creado con stock inicial 0.' });
      await refreshData('producto creado');
    } catch (error) {
      setFormStatus({ ...emptyStatus, error: getReadableError(error) });
    }
  }

  async function handleStockEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member) return;

    const entryForm = event.currentTarget;
    const form = new FormData(entryForm);
    const productId = String(form.get('productId') ?? '');
    const quantity = Number(form.get('quantity') ?? 0);
    const unitCostValue = String(form.get('unitCost') ?? '').trim();
    const unitCost = unitCostValue === '' ? null : Number.parseInt(unitCostValue, 10);
    const notes = String(form.get('notes') ?? '').trim();

    if (!productId || quantity <= 0) {
      setFormStatus({ ...emptyStatus, error: 'Selecciona un producto e ingresa una cantidad mayor a cero.' });
      return;
    }

    if (unitCost !== null && (!Number.isInteger(unitCost) || unitCost < 0)) {
      setFormStatus({ ...emptyStatus, error: 'Ingresa un costo unitario valido o deja el campo vacio.' });
      return;
    }

    setFormStatus({ ...emptyStatus, loading: true });

    try {
      await registerStockEntry({
        productId,
        quantity,
        unitCost,
        notes,
      });
      entryForm.reset();
      await refreshData('entrada registrada');
      setFormStatus({ ...emptyStatus, success: 'Entrada registrada correctamente.' });
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al registrar entrada', error);
      setFormStatus({ ...emptyStatus, error: `No se pudo registrar la entrada. ${getReadableError(error)}` });
    }
  }

  async function handleSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member) return;

    const saleForm = event.currentTarget;
    const form = new FormData(saleForm);
    const productId = String(form.get('productId') ?? '');
    const quantity = Number(form.get('quantity') ?? 0);
    const unitPrice = Number(form.get('unitPrice') ?? 0);
    const paymentMethod = String(form.get('paymentMethod') ?? 'Transferencia');
    const notes = String(form.get('notes') ?? '').trim();
    const selectedProduct = data.products.find((product) => product.id === productId);

    if (!productId || quantity <= 0) {
      setFormStatus({ ...emptyStatus, error: 'Selecciona un producto e ingresa una cantidad mayor a cero.' });
      return;
    }

    if (!selectedProduct) {
      setFormStatus({ ...emptyStatus, error: 'No se encontro el producto seleccionado.' });
      return;
    }

    if (selectedProduct.stock <= 0) {
      setFormStatus({ ...emptyStatus, error: 'Sin stock disponible.' });
      return;
    }

    if (quantity > selectedProduct.stock) {
      setFormStatus({
        ...emptyStatus,
        error: `La venta supera el stock disponible (${formatUnits(selectedProduct.stock)} unidades).`,
      });
      return;
    }

    setFormStatus({ ...emptyStatus, loading: true });

    try {
      await registerSale({
        productId,
        quantity,
        unitPrice,
        paymentMethod,
        notes,
      });
      saleForm.reset();
      setSaleFormVersion((version) => version + 1);
      await refreshData('venta registrada');
      setFormStatus({ ...emptyStatus, success: 'Venta registrada correctamente.' });
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al registrar venta', error);
      setFormStatus({ ...emptyStatus, error: `No se pudo registrar la venta. ${getReadableError(error)}` });
    }
  }

  async function handleOutput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member) return;

    const outputForm = event.currentTarget;
    const form = new FormData(outputForm);
    const productId = String(form.get('productId') ?? '');
    const quantity = Number(form.get('quantity') ?? 0);
    const movementType = String(form.get('movementType') ?? '').trim();
    const notes = String(form.get('notes') ?? '').trim();

    if (!productId || quantity <= 0 || !movementType) {
      setFormStatus({ ...emptyStatus, error: 'Selecciona producto, cantidad y motivo de salida.' });
      return;
    }

    setFormStatus({ ...emptyStatus, loading: true });

    try {
      await registerStockOutput({
        productId,
        quantity,
        movementType,
        notes,
      });
      outputForm.reset();
      await refreshData('salida registrada');
      setFormStatus({ ...emptyStatus, success: 'Salida registrada correctamente.' });
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al registrar salida', error);
      setFormStatus({ ...emptyStatus, error: `No se pudo registrar la salida. ${getReadableError(error)}` });
    }
  }

  if (!hasSupabaseConfig) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Configuracion requerida</p>
          <h1>Faltan variables de entorno</h1>
          <p>
            Crea `.env.local` con `VITE_SUPABASE_URL` y
            `VITE_SUPABASE_PUBLISHABLE_KEY`.
          </p>
        </section>
      </main>
    );
  }

  if (authLoading) {
    return <FullPageMessage title="Cargando sesion" text="Un momento..." />;
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Inventario compartido</p>
          <h1>Vicente y Jesus</h1>
          <p>Ingresa con el correo autorizado en Supabase para ver y actualizar el inventario.</p>
          <form className="stack" onSubmit={handleLogin}>
            <label>
              Correo
              <input
                autoComplete="email"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="correo@ejemplo.cl"
                required
                type="email"
                value={email}
              />
            </label>
            <label>
              Contrasena
              <input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Tu contrasena"
                required
                type="password"
                value={password}
              />
            </label>
            {authError && <Alert tone="error" text={authError} />}
            <button className="primary-button" disabled={loginLoading} type="submit">
              {loginLoading ? 'Ingresando...' : 'Iniciar sesion'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Inventario compartido</p>
          <h1>Vicente y Jesus</h1>
          <p>{member ? `Sesion de ${member.name}` : session.user.email}</p>
        </div>
        <button className="ghost-button" onClick={handleLogout} type="button">
          Cerrar sesion
        </button>
      </header>

      <nav className="tabs" aria-label="Secciones">
        {[
          ['resumen', 'Resumen'],
          ['productos', 'Productos'],
          ['operaciones', 'Movimientos'],
          ['ventas', 'Ventas'],
          ['historial', 'Historial'],
        ].map(([id, label]) => (
          <button
            className={activeTab === id ? 'active' : ''}
            key={id}
            onClick={() => setActiveTab(id as Tab)}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      {dataError && <Alert tone="error" text={dataError} />}
      {dataLoading && <Alert tone="info" text="Actualizando datos compartidos..." />}

      {activeTab === 'resumen' && <SummaryPanel summary={summary} />}
      {activeTab === 'productos' && (
        <ProductsPanel
          products={data.products}
          onCreateProduct={handleCreateProduct}
          status={formStatus}
        />
      )}
      {activeTab === 'operaciones' && (
        <OperationsPanel
          products={data.products}
          onEntry={handleStockEntry}
          onSale={handleSale}
          onOutput={handleOutput}
          saleFormVersion={saleFormVersion}
          status={formStatus}
        />
      )}
      {activeTab === 'ventas' && <SalesPanel sales={data.sales} />}
      {activeTab === 'historial' && <MovementsPanel movements={data.movements} />}
    </main>
  );
}

function FullPageMessage({ title, text }: { title: string; text: string }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1>{title}</h1>
        <p>{text}</p>
      </section>
    </main>
  );
}

function Alert({ tone, text }: { tone: 'error' | 'info' | 'success'; text: string }) {
  return <div className={`alert ${tone}`}>{text}</div>;
}

function SummaryPanel({ summary }: { summary: Record<string, number> }) {
  return (
    <section className="panel">
      <div className="summary-grid">
        <Metric label="Unidades disponibles" value={formatUnits(summary.availableUnits)} />
        <Metric label="Inventario al costo" value={formatClp(summary.inventoryCostValue)} />
        <Metric label="Ventas acumuladas" value={formatClp(summary.accumulatedSales)} />
        <Metric label="Ganancia bruta" value={formatClp(summary.grossProfit)} />
        <Metric label="Productos con stock bajo" value={formatUnits(summary.lowStockCount)} />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ProductsPanel({
  products,
  onCreateProduct,
  status,
}: {
  products: ProductView[];
  onCreateProduct: (event: FormEvent<HTMLFormElement>) => void;
  status: FormStatus;
}) {
  return (
    <section className="split-layout">
      <form className="panel form-panel" onSubmit={onCreateProduct}>
        <h2>Nuevo producto</h2>
        <label>
          Nombre
          <input name="name" placeholder="Ej: Polera negra" required />
        </label>
        <label>
          SKU opcional
          <input name="sku" placeholder="Codigo interno" />
        </label>
        <label>
          Descripcion opcional
          <input name="description" placeholder="Detalle breve del producto" />
        </label>
        <div className="two-columns">
          <label>
            Costo
            <input inputMode="numeric" min="0" name="costPrice" step="1" type="number" />
          </label>
          <label>
            Precio venta
            <input inputMode="numeric" min="0" name="salePrice" step="1" type="number" />
          </label>
        </div>
        <label>
          Stock bajo
          <input
            defaultValue="5"
            inputMode="numeric"
            min="0"
            name="lowStockThreshold"
            step="1"
            type="number"
          />
        </label>
        <FormStatusMessage status={status} />
        <button className="primary-button" disabled={status.loading} type="submit">
          Crear producto
        </button>
      </form>

      <section className="panel">
        <div className="section-title">
          <h2>Productos</h2>
          <span>{products.length} activos</span>
        </div>
        <div className="table-list">
          {products.map((product) => (
            <article className="product-row" key={product.id}>
              <div>
                <strong>{product.name}</strong>
                {product.sku && <span>SKU {product.sku}</span>}
              </div>
              <div>
                <strong>{formatUnits(product.stock)}</strong>
                <span>stock</span>
              </div>
              <div>
                <strong>{formatClp(product.salePrice)}</strong>
                <span>venta</span>
              </div>
            </article>
          ))}
          {!products.length && <EmptyState text="Todavia no hay productos para mostrar." />}
        </div>
      </section>
    </section>
  );
}

function OperationsPanel({
  products,
  onEntry,
  onSale,
  onOutput,
  saleFormVersion,
  status,
}: {
  products: ProductView[];
  onEntry: (event: FormEvent<HTMLFormElement>) => void;
  onSale: (event: FormEvent<HTMLFormElement>) => void;
  onOutput: (event: FormEvent<HTMLFormElement>) => void;
  saleFormVersion: number;
  status: FormStatus;
}) {
  return (
    <section className="operations-grid">
      <OperationForm
        button="Registrar entrada"
        disabled={status.loading}
        onSubmit={onEntry}
        products={products}
        title="Entrada de inventario"
      >
        <label>
          Costo unitario
          <input inputMode="numeric" min="0" name="unitCost" step="1" type="number" />
        </label>
        <label>
          Nota
          <input name="notes" placeholder="Compra, reposicion..." />
        </label>
      </OperationForm>

      <SaleOperationForm
        disabled={status.loading}
        key={saleFormVersion}
        onSubmit={onSale}
        products={products}
      />

      <OperationForm
        button="Registrar salida"
        disabled={status.loading}
        onSubmit={onOutput}
        products={products}
        title="Salida o daño"
      >
        <label>
          Motivo
          <select name="movementType" required>
            <option value="">Seleccionar</option>
            <option value="damaged">Producto dañado</option>
            <option value="adjustment_out">Ajuste de stock</option>
          </select>
        </label>
        <label>
          Nota
          <input name="notes" placeholder="Detalle opcional" />
        </label>
      </OperationForm>

      <div className="operation-status">
        <FormStatusMessage status={status} />
      </div>
    </section>
  );
}

function OperationForm({
  title,
  button,
  disabled = false,
  products,
  onSubmit,
  children,
}: {
  title: string;
  button: string;
  disabled?: boolean;
  products: ProductView[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <form className="panel form-panel" onSubmit={onSubmit}>
      <h2>{title}</h2>
      <label>
        Producto
        <select name="productId" required>
          <option value="">Seleccionar producto</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} - stock {formatUnits(product.stock)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Cantidad
        <input inputMode="numeric" min="1" name="quantity" required step="1" type="number" />
      </label>
      {children}
      <button className="primary-button" disabled={disabled} type="submit">
        {button}
      </button>
    </form>
  );
}

function SaleOperationForm({
  disabled = false,
  products,
  onSubmit,
}: {
  disabled?: boolean;
  products: ProductView[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [selectedProductId, setSelectedProductId] = useState('');
  const selectedProduct = products.find((product) => product.id === selectedProductId);
  const isOutOfStock = Boolean(selectedProduct && selectedProduct.stock <= 0);

  return (
    <form className="panel form-panel" onSubmit={onSubmit}>
      <h2>Venta</h2>
      <label>
        Producto
        <select
          name="productId"
          onChange={(event) => setSelectedProductId(event.target.value)}
          required
          value={selectedProductId}
        >
          <option value="">Seleccionar producto</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} - stock {formatUnits(product.stock)}
            </option>
          ))}
        </select>
      </label>
      {isOutOfStock && <p className="inline-warning">Sin stock disponible</p>}
      <label>
        Cantidad
        <input
          inputMode="numeric"
          max={selectedProduct?.stock || undefined}
          min="1"
          name="quantity"
          required
          step="1"
          type="number"
        />
      </label>
      <label>
        Precio unitario
        <input inputMode="numeric" min="0" name="unitPrice" step="1" type="number" />
      </label>
      <label>
        Método de pago
        <select defaultValue="Transferencia" name="paymentMethod" required>
          {paymentMethods.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
      </label>
      <label>
        Nota
        <input name="notes" placeholder="Cliente, canal..." />
      </label>
      <button className="primary-button" disabled={disabled || isOutOfStock} type="submit">
        Registrar venta
      </button>
    </form>
  );
}

function FormStatusMessage({ status }: { status: FormStatus }) {
  if (status.error) return <Alert tone="error" text={status.error} />;
  if (status.success) return <Alert tone="success" text={status.success} />;
  if (status.loading) return <Alert tone="info" text="Guardando..." />;
  return null;
}

function SalesPanel({ sales }: { sales: SaleView[] }) {
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Ventas</h2>
        <span>{sales.length} registros</span>
      </div>
      <div className="table-list">
        {sales.map((sale) => (
          <article className="record-row" key={sale.id}>
            <div>
              <strong>{sale.productName}</strong>
              <span>{formatDate(sale.createdAt)} por {sale.sellerName}</span>
            </div>
            <div>
              <strong>{formatUnits(sale.quantity)}</strong>
              <span>unidades</span>
            </div>
            <div>
              <strong>{formatClp(sale.total)}</strong>
              <span>total</span>
            </div>
            <div>
              <strong>{formatClp(sale.grossProfit)}</strong>
              <span>ganancia</span>
            </div>
          </article>
        ))}
        {!sales.length && <EmptyState text="Todavia no hay ventas registradas." />}
      </div>
    </section>
  );
}

function MovementsPanel({ movements }: { movements: MovementView[] }) {
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Historial de movimientos</h2>
        <span>{movements.length} registros</span>
      </div>
      <div className="table-list">
        {movements.map((movement) => (
          <article className="record-row" key={movement.id}>
            <div>
              <strong>{movement.productName}</strong>
              <span>{formatDate(movement.createdAt)}</span>
            </div>
            <div>
              <strong>{movement.type}</strong>
              <span>tipo</span>
            </div>
            <div>
              <strong>{formatUnits(movement.quantity)}</strong>
              <span>cantidad</span>
            </div>
            <div>
              <strong>{movement.note || 'Sin nota'}</strong>
              <span>detalle</span>
            </div>
          </article>
        ))}
        {!movements.length && <EmptyState text="Todavia no hay movimientos registrados." />}
      </div>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}

export default App;
