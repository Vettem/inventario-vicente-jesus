import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PostgrestError, Session } from '@supabase/supabase-js';
import {
  Activity,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  BadgeDollarSign,
  Boxes,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Home,
  LogOut,
  LucideIcon,
  Menu,
  MoreHorizontal,
  PackagePlus,
  PackageSearch,
  Receipt,
  RefreshCw,
  TrendingUp,
  Warehouse,
  X,
  XCircle,
} from 'lucide-react';
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
type OperationTab = 'entry' | 'sale' | 'output';
type ToastTone = 'success' | 'error' | 'warning';
type BadgeTone = 'green' | 'teal' | 'red' | 'yellow' | 'gray' | 'blue';
type HistoryFilter = 'all' | 'entries' | 'sales' | 'outputs' | 'damages';

type LoadState = {
  products: ProductView[];
  members: MemberView[];
  sales: SaleView[];
  movements: MovementView[];
};

type FormStatus = {
  loading: boolean;
};

type ToastMessage = {
  id: number;
  tone: ToastTone;
  title: string;
  text?: string;
};

type Summary = {
  availableUnits: number;
  inventoryCostValue: number;
  accumulatedSales: number;
  grossProfit: number;
  lowStockCount: number;
};

type NavItem = {
  id: Tab;
  label: string;
  icon: LucideIcon;
};

type MovementMeta = {
  label: string;
  tone: BadgeTone;
  category: Exclude<HistoryFilter, 'all'>;
};

const initialData: LoadState = {
  products: [],
  members: [],
  sales: [],
  movements: [],
};

const emptyStatus: FormStatus = {
  loading: false,
};

const navItems: NavItem[] = [
  { id: 'resumen', label: 'Resumen', icon: Home },
  { id: 'productos', label: 'Productos', icon: Boxes },
  { id: 'operaciones', label: 'Movimientos', icon: Activity },
  { id: 'ventas', label: 'Ventas', icon: Receipt },
  { id: 'historial', label: 'Historial', icon: ClipboardList },
];

const paymentMethods = ['Transferencia', 'Efectivo', 'Debito', 'Credito', 'Otro'];

const movementTypeMeta: Record<string, MovementMeta> = {
  purchase: { label: 'Entrada', tone: 'green', category: 'entries' },
  sale: { label: 'Venta', tone: 'teal', category: 'sales' },
  damaged: { label: 'Producto dañado', tone: 'red', category: 'damages' },
  loss: { label: 'Perdida', tone: 'red', category: 'damages' },
  adjustment_in: {
    label: 'Ajuste de entrada',
    tone: 'yellow',
    category: 'entries',
  },
  adjustment_out: {
    label: 'Ajuste de salida',
    tone: 'yellow',
    category: 'outputs',
  },
};

const historyFilters: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'entries', label: 'Entradas' },
  { id: 'sales', label: 'Ventas' },
  { id: 'outputs', label: 'Salidas' },
  { id: 'damages', label: 'Daños' },
];

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
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastIdRef = useRef(0);
  const activeSessionRef = useRef<Session | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);

  const showToast = useCallback(
    (tone: ToastTone, title: string, text?: string) => {
      toastIdRef.current += 1;
      const toast: ToastMessage = {
        id: toastIdRef.current,
        tone,
        title,
        text,
      };

      setToasts((current) => [...current, toast]);
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    if (!toasts.length) return undefined;

    const timeoutId = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 3800);

    return () => window.clearTimeout(timeoutId);
  }, [toasts]);

  const loadData = useCallback(async (currentSession: Session) => {
    if (!currentSession.user) return;

    setDataLoading(true);
    setDataError('');

    try {
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
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al cargar datos', error);
      setDataError(getReadableError(error));
    } finally {
      setDataLoading(false);
    }
  }, []);

  const refreshData = useCallback(async () => {
    const currentSession = activeSessionRef.current;
    if (!currentSession) {
      setDataError('No hay una sesion activa para actualizar los datos.');
      return;
    }

    await loadData(currentSession);
  }, [loadData]);

  useEffect(() => {
    let cancelled = false;

    const applySession = async (nextSession: Session | null) => {
      if (cancelled) return;

      setSession(nextSession);
      activeSessionRef.current = nextSession;
      setAuthLoading(false);

      if (!nextSession) {
        loadedUserIdRef.current = null;
        setMember(null);
        setData(initialData);
        return;
      }

      if (loadedUserIdRef.current === nextSession.user.id) return;

      loadedUserIdRef.current = nextSession.user.id;
      await loadData(nextSession);
    };

    void supabase.auth.getSession().then(({ data: authData, error }) => {
      if (error) {
        setAuthError(getReadableError(error));
        setAuthLoading(false);
        return;
      }

      void applySession(authData.session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'TOKEN_REFRESHED' && nextSession) {
        setSession(nextSession);
        activeSessionRef.current = nextSession;
        return;
      }

      void applySession(nextSession);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadData]);

  const summary = useMemo((): Summary => {
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

  const displayName = member?.name || session?.user.email || 'Usuario';

  function navigateTo(tab: Tab) {
    setActiveTab(tab);
    setToasts([]);
    setFormStatus(emptyStatus);
  }

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
    if (error) {
      showToast('error', 'No se pudo cerrar sesion', getReadableError(error));
    }
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
      showToast('error', 'Sesion requerida', 'No hay un usuario autenticado para crear el producto.');
      return;
    }

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Ingresa el nombre del producto.');
      return;
    }

    setFormStatus({ loading: true });

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
        logSupabaseError('[inventario] error Supabase al crear producto', error);
        throw error;
      }

      productForm.reset();
      await refreshData();
      showToast('success', 'Producto creado', 'Se agrego con stock inicial 0.');
    } catch (error) {
      showToast('error', 'No se pudo crear el producto', getReadableError(error));
    } finally {
      setFormStatus(emptyStatus);
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
      showToast('warning', 'Datos incompletos', 'Selecciona un producto e ingresa una cantidad mayor a cero.');
      return;
    }

    if (unitCost !== null && (!Number.isInteger(unitCost) || unitCost < 0)) {
      showToast('warning', 'Costo invalido', 'Ingresa un costo unitario valido o deja el campo vacio.');
      return;
    }

    setFormStatus({ loading: true });

    try {
      await registerStockEntry({
        productId,
        quantity,
        unitCost,
        notes,
      });
      entryForm.reset();
      await refreshData();
      showToast('success', 'Entrada registrada', 'El inventario fue actualizado.');
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al registrar entrada', error);
      showToast('error', 'No se pudo registrar la entrada', getReadableError(error));
    } finally {
      setFormStatus(emptyStatus);
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
      showToast('warning', 'Datos incompletos', 'Selecciona un producto e ingresa una cantidad mayor a cero.');
      return;
    }

    if (!selectedProduct) {
      showToast('error', 'Producto no encontrado', 'No se encontro el producto seleccionado.');
      return;
    }

    if (selectedProduct.stock <= 0) {
      showToast('warning', 'Sin stock disponible', 'El producto seleccionado no tiene unidades disponibles.');
      return;
    }

    if (quantity > selectedProduct.stock) {
      showToast(
        'warning',
        'Stock insuficiente',
        `Hay ${formatUnits(selectedProduct.stock)} unidades disponibles.`,
      );
      return;
    }

    setFormStatus({ loading: true });

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
      await refreshData();
      showToast('success', 'Venta registrada', 'Stock y ventas fueron actualizados.');
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al registrar venta', error);
      showToast('error', 'No se pudo registrar la venta', getReadableError(error));
    } finally {
      setFormStatus(emptyStatus);
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
      showToast('warning', 'Datos incompletos', 'Selecciona producto, cantidad y motivo de salida.');
      return;
    }

    setFormStatus({ loading: true });

    try {
      await registerStockOutput({
        productId,
        quantity,
        movementType,
        notes,
      });
      outputForm.reset();
      await refreshData();
      showToast('success', 'Salida registrada', 'El inventario fue actualizado.');
    } catch (error) {
      logSupabaseError('[inventario] error Supabase al registrar salida', error);
      showToast('error', 'No se pudo registrar la salida', getReadableError(error));
    } finally {
      setFormStatus(emptyStatus);
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
    return <FullPageMessage title="Cargando sesion" text="Preparando tu inventario compartido..." />;
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card login-card">
          <div className="brand-mark">
            <Warehouse aria-hidden="true" size={28} />
          </div>
          <p className="eyebrow">Inventario compartido</p>
          <h1>Vicente y Jesus</h1>
          <p>Ingresa con el correo autorizado en Supabase para ver y actualizar el inventario.</p>
          <form className="stack" onSubmit={handleLogin}>
            <FormField label="Correo">
              <input
                autoComplete="email"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="correo@ejemplo.cl"
                required
                type="email"
                value={email}
              />
            </FormField>
            <FormField label="Contrasena">
              <input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Tu contrasena"
                required
                type="password"
                value={password}
              />
            </FormField>
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
    <div className="dashboard-shell">
      <Sidebar
        activeTab={activeTab}
        displayName={displayName}
        email={session.user.email ?? ''}
        onLogout={handleLogout}
        onNavigate={navigateTo}
      />
      <MobileNavigation
        activeTab={activeTab}
        onNavigate={navigateTo}
      />
      <ToastViewport onDismiss={dismissToast} toasts={toasts} />
      <main className="main-content">
        {dataError && <Alert tone="error" text={dataError} />}
        {activeTab === 'resumen' && (
          <SummaryPanel
            displayName={displayName}
            loading={dataLoading}
            movements={data.movements}
            products={data.products}
            summary={summary}
          />
        )}
        {activeTab === 'productos' && (
          <ProductsPanel
            loading={dataLoading}
            onCreateProduct={handleCreateProduct}
            products={data.products}
            status={formStatus}
          />
        )}
        {activeTab === 'operaciones' && (
          <OperationsPanel
            loading={dataLoading}
            onEntry={handleStockEntry}
            onOutput={handleOutput}
            onSale={handleSale}
            products={data.products}
            saleFormVersion={saleFormVersion}
            status={formStatus}
          />
        )}
        {activeTab === 'ventas' && (
          <SalesPanel loading={dataLoading} sales={data.sales} />
        )}
        {activeTab === 'historial' && (
          <MovementsPanel loading={dataLoading} movements={data.movements} />
        )}
      </main>
    </div>
  );
}

function Sidebar({
  activeTab,
  displayName,
  email,
  onLogout,
  onNavigate,
}: {
  activeTab: Tab;
  displayName: string;
  email: string;
  onLogout: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <Warehouse aria-hidden="true" size={24} />
        </div>
        <div>
          <strong>Inventario VJ</strong>
          <span>Vicente y Jesus</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Navegacion principal">
        {navItems.map((item) => (
          <button
            aria-current={activeTab === item.id ? 'page' : undefined}
            className={activeTab === item.id ? 'nav-link active' : 'nav-link'}
            key={item.id}
            onClick={() => onNavigate(item.id)}
            type="button"
          >
            <item.icon aria-hidden="true" size={19} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-user">
        <div className="user-avatar" aria-hidden="true">
          {getInitials(displayName)}
        </div>
        <div className="user-copy">
          <strong>{displayName}</strong>
          <span>{email}</span>
        </div>
        <button aria-label="Cerrar sesion" className="icon-button" onClick={onLogout} type="button">
          <LogOut aria-hidden="true" size={18} />
        </button>
      </div>
    </aside>
  );
}

function MobileNavigation({
  activeTab,
  onNavigate,
}: {
  activeTab: Tab;
  onNavigate: (tab: Tab) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeItem = navItems.find((item) => item.id === activeTab) ?? navItems[0];

  function handleNavigate(tab: Tab) {
    onNavigate(tab);
    setOpen(false);
  }

  return (
    <header className="mobile-header">
      <button
        aria-expanded={open}
        aria-label="Abrir navegacion"
        className="mobile-menu-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
      </button>
      <div>
        <span>Inventario VJ</span>
        <strong>{activeItem.label}</strong>
      </div>
      {open && (
        <nav className="mobile-menu" aria-label="Navegacion movil">
          {navItems.map((item) => (
            <button
              className={activeTab === item.id ? 'mobile-link active' : 'mobile-link'}
              key={item.id}
              onClick={() => handleNavigate(item.id)}
              type="button"
            >
              <item.icon aria-hidden="true" size={18} />
              {item.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}

function PageHeader({
  title,
  eyebrow,
  description,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

function SummaryPanel({
  displayName,
  loading,
  movements,
  products,
  summary,
}: {
  displayName: string;
  loading: boolean;
  movements: MovementView[];
  products: ProductView[];
  summary: Summary;
}) {
  const recentMovements = movements.slice(0, 5);
  const lowStockProducts = [...products]
    .sort((first, second) => first.stock - second.stock)
    .slice(0, 5);

  return (
    <section className="page-stack">
      <PageHeader
        description="Este es el estado actual del inventario compartido."
        eyebrow="Resumen"
        title={`${getGreeting()}, ${displayName}`}
      >
        {loading && <LoadingPill text="Actualizando" />}
      </PageHeader>

      <div className="stat-grid">
        <StatCard
          icon={Boxes}
          label="Unidades disponibles"
          value={formatUnits(summary.availableUnits)}
          helper="Stock total entre productos activos y cargados."
        />
        <StatCard
          icon={Warehouse}
          label="Inventario al costo"
          value={formatClp(summary.inventoryCostValue)}
          helper="Valorizado con costo unitario."
        />
        <StatCard
          icon={BadgeDollarSign}
          label="Ventas acumuladas"
          value={formatClp(summary.accumulatedSales)}
          helper="Total vendido registrado."
        />
        <StatCard
          icon={TrendingUp}
          label="Ganancia bruta"
          value={formatClp(summary.grossProfit)}
          helper="Margen bruto acumulado."
        />
        <StatCard
          icon={AlertTriangle}
          label="Stock bajo"
          value={formatUnits(summary.lowStockCount)}
          helper="Productos bajo o igual al minimo."
        />
      </div>

      <div className="dashboard-grid">
        <section className="panel">
          <SectionHeading
            icon={Activity}
            subtitle="Ultimos registros del inventario."
            title="Actividad reciente"
          />
          {loading && !recentMovements.length ? (
            <LoadingState text="Cargando historial..." />
          ) : (
            <div className="activity-list">
              {recentMovements.map((movement) => (
                <MovementMiniCard key={movement.id} movement={movement} />
              ))}
              {!recentMovements.length && <EmptyState text="Sin movimientos recientes." />}
            </div>
          )}
        </section>

        <section className="panel">
          <SectionHeading
            icon={PackageSearch}
            subtitle="Hasta cinco productos ordenados por menor stock."
            title="Productos con menor stock"
          />
          {loading && !lowStockProducts.length ? (
            <LoadingState text="Cargando productos..." />
          ) : (
            <div className="compact-list">
              {lowStockProducts.map((product) => (
                <ProductStockRow key={product.id} product={product} />
              ))}
              {!lowStockProducts.length && <EmptyState text="Sin productos para mostrar." />}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function ProductsPanel({
  loading,
  onCreateProduct,
  products,
  status,
}: {
  loading: boolean;
  onCreateProduct: (event: FormEvent<HTMLFormElement>) => void;
  products: ProductView[];
  status: FormStatus;
}) {
  return (
    <section className="page-stack">
      <PageHeader
        description="Crea productos y revisa stock, costos y margenes calculados en frontend."
        eyebrow="Productos"
        title="Catalogo de inventario"
      >
        {loading && <LoadingPill text="Actualizando" />}
      </PageHeader>

      <div className="products-layout">
        <form className="panel form-panel elevated-form" onSubmit={onCreateProduct}>
          <SectionHeading
            icon={PackagePlus}
            subtitle="El stock inicial se guarda siempre en 0."
            title="Nuevo producto"
          />
          <FormField label="Nombre">
            <input name="name" placeholder="Ej: Polera negra" required />
          </FormField>
          <FormField label="SKU opcional">
            <input name="sku" placeholder="Codigo interno" />
          </FormField>
          <FormField label="Descripcion opcional">
            <input name="description" placeholder="Detalle breve del producto" />
          </FormField>
          <div className="two-columns">
            <FormField label="Costo">
              <input inputMode="numeric" min="0" name="costPrice" step="1" type="number" />
            </FormField>
            <FormField label="Precio venta">
              <input inputMode="numeric" min="0" name="salePrice" step="1" type="number" />
            </FormField>
          </div>
          <FormField label="Stock bajo">
            <input
              defaultValue="5"
              inputMode="numeric"
              min="0"
              name="lowStockThreshold"
              step="1"
              type="number"
            />
          </FormField>
          <button className="primary-button" disabled={status.loading} type="submit">
            {status.loading ? 'Creando...' : 'Crear producto'}
          </button>
        </form>

        <section className="panel">
          <SectionHeading
            icon={Boxes}
            subtitle={`${products.length} productos cargados.`}
            title="Lista de productos"
          />
          {loading && !products.length ? (
            <LoadingState text="Cargando productos..." />
          ) : (
            <div className="product-card-grid">
              {products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
              {!products.length && <EmptyState text="Sin productos. Crea el primero desde el formulario." />}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function OperationsPanel({
  loading,
  onEntry,
  onSale,
  onOutput,
  products,
  saleFormVersion,
  status,
}: {
  loading: boolean;
  onEntry: (event: FormEvent<HTMLFormElement>) => void;
  onSale: (event: FormEvent<HTMLFormElement>) => void;
  onOutput: (event: FormEvent<HTMLFormElement>) => void;
  products: ProductView[];
  saleFormVersion: number;
  status: FormStatus;
}) {
  const [activeOperation, setActiveOperation] = useState<OperationTab>('entry');

  const operationMeta: Record<OperationTab, { title: string; text: string; icon: LucideIcon }> = {
    entry: {
      title: 'Registrar entrada',
      text: 'Compra o reposicion de stock.',
      icon: ArrowUpCircle,
    },
    sale: {
      title: 'Registrar venta',
      text: 'Descuenta stock y suma ventas.',
      icon: CreditCard,
    },
    output: {
      title: 'Registrar salida',
      text: 'Daños o ajustes de salida.',
      icon: ArrowDownCircle,
    },
  };

  return (
    <section className="page-stack">
      <PageHeader
        description="Elige un tipo de movimiento y registra solo lo necesario."
        eyebrow="Movimientos"
        title="Operaciones de inventario"
      >
        {loading && <LoadingPill text="Actualizando" />}
      </PageHeader>

      <section className="panel operations-panel">
        <div className="segmented-control" role="tablist" aria-label="Tipo de movimiento">
          {(Object.keys(operationMeta) as OperationTab[]).map((operation) => {
            const item = operationMeta[operation];
            return (
              <button
                aria-selected={activeOperation === operation}
                className={activeOperation === operation ? 'segment active' : 'segment'}
                key={operation}
                onClick={() => setActiveOperation(operation)}
                role="tab"
                type="button"
              >
                <item.icon aria-hidden="true" size={18} />
                <span>{item.title}</span>
                <small>{item.text}</small>
              </button>
            );
          })}
        </div>

        <div className="operation-form-shell">
          {activeOperation === 'entry' && (
            <EntryForm disabled={status.loading} onSubmit={onEntry} products={products} />
          )}
          {activeOperation === 'sale' && (
            <SaleOperationForm
              disabled={status.loading}
              key={saleFormVersion}
              onSubmit={onSale}
              products={products}
            />
          )}
          {activeOperation === 'output' && (
            <OutputForm disabled={status.loading} onSubmit={onOutput} products={products} />
          )}
        </div>
      </section>
    </section>
  );
}

function SalesPanel({ loading, sales }: { loading: boolean; sales: SaleView[] }) {
  const totals = useMemo(
    () => ({
      sold: sales.reduce((sum, sale) => sum + sale.total, 0),
      profit: sales.reduce((sum, sale) => sum + sale.grossProfit, 0),
    }),
    [sales],
  );

  return (
    <section className="page-stack">
      <PageHeader
        description="Revisa cada venta con vendedor, metodo de pago y margen bruto."
        eyebrow="Ventas"
        title="Registro comercial"
      >
        {loading && <LoadingPill text="Actualizando" />}
      </PageHeader>

      <div className="sales-summary">
        <MiniMetric label="Registros" value={formatUnits(sales.length)} />
        <MiniMetric label="Total vendido" value={formatClp(totals.sold)} />
        <MiniMetric label="Ganancia total" value={formatClp(totals.profit)} />
      </div>

      <section className="panel">
        {loading && !sales.length ? (
          <LoadingState text="Cargando ventas..." />
        ) : (
          <div className="sales-list">
            {sales.map((sale) => (
              <SaleCard key={sale.id} sale={sale} />
            ))}
            {!sales.length && <EmptyState text="Sin ventas registradas." />}
          </div>
        )}
      </section>
    </section>
  );
}

function MovementsPanel({
  loading,
  movements,
}: {
  loading: boolean;
  movements: MovementView[];
}) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const filteredMovements = movements.filter((movement) => {
    if (filter === 'all') return true;
    return getMovementMeta(movement.type).category === filter;
  });

  return (
    <section className="page-stack">
      <PageHeader
        description="Consulta el historial traducido y filtrado sin mostrar codigos tecnicos."
        eyebrow="Historial"
        title="Movimientos registrados"
      >
        {loading && <LoadingPill text="Actualizando" />}
      </PageHeader>

      <section className="panel">
        <div className="filter-row" aria-label="Filtros de historial">
          {historyFilters.map((item) => (
            <button
              className={filter === item.id ? 'filter-chip active' : 'filter-chip'}
              key={item.id}
              onClick={() => setFilter(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        {loading && !movements.length ? (
          <LoadingState text="Cargando historial..." />
        ) : (
          <div className="history-list">
            {filteredMovements.map((movement) => (
              <MovementCard key={movement.id} movement={movement} />
            ))}
            {!filteredMovements.length && <EmptyState text="Sin movimientos para este filtro." />}
          </div>
        )}
      </section>
    </section>
  );
}

function EntryForm({
  disabled,
  onSubmit,
  products,
}: {
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  products: ProductView[];
}) {
  return (
    <form className="form-panel movement-form" onSubmit={onSubmit}>
      <SectionHeading
        icon={ArrowUpCircle}
        subtitle="Usa costo unitario vacio si no aplica."
        title="Entrada de inventario"
      />
      <ProductSelect products={products} />
      <FormField label="Cantidad">
        <input inputMode="numeric" min="1" name="quantity" required step="1" type="number" />
      </FormField>
      <FormField label="Costo unitario">
        <input inputMode="numeric" min="0" name="unitCost" step="1" type="number" />
      </FormField>
      <FormField label="Nota">
        <input name="notes" placeholder="Compra, reposicion..." />
      </FormField>
      <button className="primary-button" disabled={disabled} type="submit">
        {disabled ? 'Guardando...' : 'Registrar entrada'}
      </button>
    </form>
  );
}

function SaleOperationForm({
  disabled,
  products,
  onSubmit,
}: {
  disabled: boolean;
  products: ProductView[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [selectedProductId, setSelectedProductId] = useState('');
  const selectedProduct = products.find((product) => product.id === selectedProductId);
  const isOutOfStock = Boolean(selectedProduct && selectedProduct.stock <= 0);

  return (
    <form className="form-panel movement-form" onSubmit={onSubmit}>
      <SectionHeading
        icon={CreditCard}
        subtitle="Transferencia queda seleccionada por defecto."
        title="Venta"
      />
      <FormField label="Producto">
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
      </FormField>
      {isOutOfStock && <p className="inline-warning">Sin stock disponible</p>}
      <FormField label="Cantidad">
        <input
          inputMode="numeric"
          max={selectedProduct?.stock || undefined}
          min="1"
          name="quantity"
          required
          step="1"
          type="number"
        />
      </FormField>
      <FormField label="Precio unitario">
        <input inputMode="numeric" min="0" name="unitPrice" step="1" type="number" />
      </FormField>
      <FormField label="Metodo de pago">
        <select defaultValue="Transferencia" name="paymentMethod" required>
          {paymentMethods.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Nota o cliente">
        <input name="notes" placeholder="Cliente, canal..." />
      </FormField>
      <button className="primary-button" disabled={disabled || isOutOfStock} type="submit">
        {disabled ? 'Guardando...' : 'Registrar venta'}
      </button>
    </form>
  );
}

function OutputForm({
  disabled,
  onSubmit,
  products,
}: {
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  products: ProductView[];
}) {
  return (
    <form className="form-panel movement-form" onSubmit={onSubmit}>
      <SectionHeading
        icon={ArrowDownCircle}
        subtitle="Registra daños o ajustes de salida."
        title="Salida o daño"
      />
      <ProductSelect products={products} />
      <FormField label="Cantidad">
        <input inputMode="numeric" min="1" name="quantity" required step="1" type="number" />
      </FormField>
      <FormField label="Motivo">
        <select name="movementType" required>
          <option value="">Seleccionar</option>
          <option value="damaged">Producto dañado</option>
          <option value="adjustment_out">Ajuste de stock</option>
        </select>
      </FormField>
      <FormField label="Nota">
        <input name="notes" placeholder="Detalle opcional" />
      </FormField>
      <button className="primary-button" disabled={disabled} type="submit">
        {disabled ? 'Guardando...' : 'Registrar salida'}
      </button>
    </form>
  );
}

function ProductSelect({ products }: { products: ProductView[] }) {
  return (
    <FormField label="Producto">
      <select name="productId" required>
        <option value="">Seleccionar producto</option>
        {products.map((product) => (
          <option key={product.id} value={product.id}>
            {product.name} - stock {formatUnits(product.stock)}
          </option>
        ))}
      </select>
    </FormField>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  helper,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <article className="stat-card">
      <div className="stat-icon">
        <Icon aria-hidden="true" size={22} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{helper}</p>
    </article>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <article className="mini-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ProductCard({ product }: { product: ProductView }) {
  const unitProfit = product.salePrice - product.costPrice;
  const costStockValue = product.stock * product.costPrice;
  const status = getProductStatus(product);

  return (
    <article className="product-card">
      <div className="card-topline">
        <div>
          <h3>{product.name}</h3>
          <span>{product.sku ? `SKU ${product.sku}` : 'Sin SKU'}</span>
        </div>
        <div className="card-actions">
          <Badge tone={status.tone}>{status.label}</Badge>
          <button aria-label="Acciones no disponibles" className="icon-button" disabled type="button">
            <MoreHorizontal aria-hidden="true" size={18} />
          </button>
        </div>
      </div>
      <div className="product-metrics">
        <MiniMetric label="Stock" value={formatUnits(product.stock)} />
        <MiniMetric label="Costo" value={formatClp(product.costPrice)} />
        <MiniMetric label="Venta" value={formatClp(product.salePrice)} />
        <MiniMetric label="Ganancia/u" value={formatClp(unitProfit)} />
        <MiniMetric label="Stock al costo" value={formatClp(costStockValue)} />
      </div>
    </article>
  );
}

function ProductStockRow({ product }: { product: ProductView }) {
  const status = getProductStatus(product);

  return (
    <article className="stock-row">
      <div>
        <strong>{product.name}</strong>
        <span>{product.sku || 'Sin SKU'}</span>
      </div>
      <div>
        <strong>{formatUnits(product.stock)}</strong>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
    </article>
  );
}

function MovementMiniCard({ movement }: { movement: MovementView }) {
  const meta = getMovementMeta(movement.type);

  return (
    <article className="activity-item">
      <div className="activity-icon">
        {getMovementIcon(movement.type)}
      </div>
      <div>
        <strong>{movement.productName}</strong>
        <span>{formatDate(movement.createdAt)}</span>
        {movement.note && <p>{movement.note}</p>}
      </div>
      <div className="activity-side">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <strong>{formatUnits(movement.quantity)}</strong>
      </div>
    </article>
  );
}

function SaleCard({ sale }: { sale: SaleView }) {
  return (
    <article className="sale-card">
      <div className="card-topline">
        <div>
          <h3>{sale.productName}</h3>
          <span>{formatDate(sale.createdAt)} por {sale.sellerName}</span>
        </div>
        <Badge tone="teal">{sale.paymentMethod}</Badge>
      </div>
      <div className="sale-grid">
        <MiniMetric label="Cantidad" value={formatUnits(sale.quantity)} />
        <MiniMetric label="Total vendido" value={formatClp(sale.total)} />
        <MiniMetric label="Ganancia" value={formatClp(sale.grossProfit)} />
      </div>
      {sale.note && <p className="record-note">{sale.note}</p>}
    </article>
  );
}

function MovementCard({ movement }: { movement: MovementView }) {
  const meta = getMovementMeta(movement.type);

  return (
    <article className="history-card">
      <div className="card-topline">
        <div>
          <h3>{movement.productName}</h3>
          <span>{formatDate(movement.createdAt)}</span>
        </div>
        <MovementTypeBadge type={movement.type} />
      </div>
      <div className="history-body">
        <MiniMetric label="Tipo" value={meta.label} />
        <MiniMetric label="Cantidad" value={formatUnits(movement.quantity)} />
      </div>
      <p className="record-note">{movement.note || 'Sin nota'}</p>
    </article>
  );
}

function MovementTypeBadge({ type }: { type: string }) {
  const meta = getMovementMeta(type);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function Badge({ children, tone }: { children: ReactNode; tone: BadgeTone }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function SectionHeading({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="section-heading">
      <span className="section-icon">
        <Icon aria-hidden="true" size={18} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function FormField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label>
      <span>{label}</span>
      {children}
    </label>
  );
}

function ToastViewport({
  onDismiss,
  toasts,
}: {
  onDismiss: (id: number) => void;
  toasts: ToastMessage[];
}) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <Toast key={toast.id} onDismiss={() => onDismiss(toast.id)} toast={toast} />
      ))}
    </div>
  );
}

function Toast({
  onDismiss,
  toast,
}: {
  onDismiss: () => void;
  toast: ToastMessage;
}) {
  const Icon = toast.tone === 'success'
    ? CheckCircle2
    : toast.tone === 'warning'
      ? AlertTriangle
      : XCircle;

  return (
    <div className={`toast ${toast.tone}`}>
      <Icon aria-hidden="true" size={20} />
      <div>
        <strong>{toast.title}</strong>
        {toast.text && <p>{toast.text}</p>}
      </div>
      <button aria-label="Cerrar mensaje" className="toast-close" onClick={onDismiss} type="button">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

function Alert({ tone, text }: { tone: 'error' | 'info' | 'success'; text: string }) {
  return <div className={`alert ${tone}`}>{text}</div>;
}

function LoadingPill({ text }: { text: string }) {
  return (
    <span className="loading-pill">
      <RefreshCw aria-hidden="true" size={15} />
      {text}
    </span>
  );
}

function LoadingState({ text }: { text: string }) {
  return (
    <div className="loading-state">
      <RefreshCw aria-hidden="true" size={22} />
      <p>{text}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <PackageSearch aria-hidden="true" size={24} />
      <p>{text}</p>
    </div>
  );
}

function FullPageMessage({ title, text }: { title: string; text: string }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand-mark">
          <Warehouse aria-hidden="true" size={26} />
        </div>
        <h1>{title}</h1>
        <p>{text}</p>
      </section>
    </main>
  );
}

function getProductStatus(product: ProductView): { label: string; tone: BadgeTone } {
  if (!product.active) return { label: 'Inactivo', tone: 'gray' };
  if (product.stock <= 0) return { label: 'Sin stock', tone: 'red' };
  if (product.stock <= product.lowStockThreshold) return { label: 'Stock bajo', tone: 'yellow' };
  return { label: 'Disponible', tone: 'green' };
}

function getMovementMeta(type: string): MovementMeta {
  return movementTypeMeta[type] ?? {
    label: 'Movimiento',
    tone: 'gray',
    category: 'outputs',
  };
}

function getMovementIcon(type: string) {
  const meta = getMovementMeta(type);
  if (meta.category === 'entries') return <ArrowUpCircle aria-hidden="true" size={18} />;
  if (meta.category === 'sales') return <Receipt aria-hidden="true" size={18} />;
  if (meta.category === 'damages') return <AlertTriangle aria-hidden="true" size={18} />;
  return <ArrowDownCircle aria-hidden="true" size={18} />;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos dias';
  if (hour < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

function getInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'VJ';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function logSupabaseError(context: string, error: unknown) {
  const supabaseError = error as Partial<PostgrestError>;

  console.error(context, {
    message: supabaseError.message,
    details: supabaseError.details,
    hint: supabaseError.hint,
    code: supabaseError.code,
  });
}

export default App;
