-- Convert an order into a tenant-aware sale in one atomic transaction.
-- Shipping is paid directly to the carrier and is never part of sale revenue.

begin;

do $$
declare
  v_missing text;
begin
  if to_regprocedure('public.register_sale(uuid,integer,integer,text,text)') is null then
    raise exception 'Expected public.register_sale(uuid, integer, integer, text, text) was not found';
  end if;

  if to_regprocedure('public.is_active_member()') is null then
    raise exception 'Expected public.is_active_member() was not found';
  end if;

  if to_regprocedure('public.is_organization_member(uuid)') is null then
    raise exception 'Expected public.is_organization_member(uuid) was not found';
  end if;

  select string_agg(required.table_name || '.' || required.column_name, ', ')
  into v_missing
  from (
    values
      ('orders', 'id'),
      ('orders', 'organization_id'),
      ('orders', 'product_id'),
      ('orders', 'quantity'),
      ('orders', 'base_unit_price'),
      ('orders', 'extra_quantity'),
      ('orders', 'extra_unit_price'),
      ('orders', 'shipping_cost'),
      ('orders', 'order_status'),
      ('sales', 'id'),
      ('sales', 'organization_id'),
      ('sales', 'unit_price'),
      ('sales', 'unit_cost'),
      ('sales', 'total_amount'),
      ('sales', 'total_cost'),
      ('sales', 'gross_profit'),
      ('products', 'id'),
      ('products', 'organization_id'),
      ('products', 'stock'),
      ('products', 'cost_price')
  ) as required(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns as c
    where c.table_schema = 'public'
      and c.table_name = required.table_name
      and c.column_name = required.column_name
  );

  if v_missing is not null then
    raise exception 'Order sale migration aborted. Required columns are missing: %', v_missing;
  end if;
end
$$;

alter table public.sales
  add column extra_quantity integer not null default 0,
  add column extra_unit_price integer not null default 0,
  add constraint sales_extra_quantity_nonnegative_check
    check (extra_quantity >= 0),
  add constraint sales_extra_unit_price_nonnegative_check
    check (extra_unit_price >= 0);

comment on column public.sales.extra_quantity is
  'Historical order extra quantity. Manual sales keep the default value 0.';

comment on column public.sales.extra_unit_price is
  'Historical order extra unit price. Extras add revenue but currently have no separate cost.';

alter table public.orders
  add column sale_id uuid,
  add constraint orders_sale_id_key unique (sale_id),
  add constraint orders_sale_organization_fkey
    foreign key (sale_id, organization_id)
    references public.sales(id, organization_id);

comment on column public.orders.sale_id is
  'The single sale atomically created from this order. Tenant-aware FK prevents cross-organization links.';

create function public.protect_order_sale_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.sale_id is not null and (
    new.product_id is distinct from old.product_id
    or new.quantity is distinct from old.quantity
    or new.base_unit_price is distinct from old.base_unit_price
    or new.extra_quantity is distinct from old.extra_quantity
    or new.extra_unit_price is distinct from old.extra_unit_price
    or new.shipping_cost is distinct from old.shipping_cost
  ) then
    raise exception 'Commercial fields of an order with a registered sale are immutable'
      using errcode = '23514';
  end if;

  if new.sale_id is distinct from old.sale_id
    and auth.uid() is not null
    and (
      current_setting('app.inventory_operation', true) <> 'register_sale'
      or current_setting('app.inventory_organization_id', true)
        is distinct from old.organization_id::text
    ) then
    raise exception 'An order sale link can only be changed by register_order_sale'
      using errcode = '42501';
  end if;

  return new;
end
$$;

revoke all on function public.protect_order_sale_link() from public, anon, authenticated;

create trigger orders_protect_sale_link
  before update on public.orders
  for each row execute function public.protect_order_sale_link();

create function public.register_order_sale(p_order_id uuid)
returns table (
  order_id uuid,
  sale_id uuid,
  commercial_total integer,
  sale_created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders;
  v_product public.products;
  v_sale public.sales;
  v_commercial_total_bigint bigint;
  v_total_cost_bigint bigint;
  v_commercial_total integer;
  v_total_cost integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not public.is_active_member() then
    raise exception 'User is not globally active' using errcode = '42501';
  end if;

  if p_order_id is null then
    raise exception 'Order id is required' using errcode = '22023';
  end if;

  select o.*
  into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if not public.is_organization_member(v_order.organization_id) then
    raise exception 'The authenticated user is not an active member of this organization'
      using errcode = '42501';
  end if;

  if v_order.sale_id is not null then
    raise exception 'This order already has a registered sale'
      using errcode = '23505';
  end if;

  if v_order.order_status = 'cancelled' then
    raise exception 'A cancelled order cannot be registered as a sale'
      using errcode = '22023';
  end if;

  select p.*
  into v_product
  from public.products as p
  where p.id = v_order.product_id
  for update;

  if not found then
    raise exception 'Order product not found' using errcode = 'P0002';
  end if;

  if v_product.organization_id <> v_order.organization_id then
    raise exception 'Order and product must belong to the same organization'
      using errcode = '23514';
  end if;

  if v_product.stock < v_order.quantity then
    raise exception 'Insufficient stock for this order'
      using errcode = '22023';
  end if;

  v_commercial_total_bigint :=
    (v_order.base_unit_price::bigint * v_order.quantity::bigint)
    + (v_order.extra_quantity::bigint * v_order.extra_unit_price::bigint);
  v_total_cost_bigint := v_product.cost_price::bigint * v_order.quantity::bigint;

  if v_commercial_total_bigint < 0
    or v_commercial_total_bigint > 2147483647 then
    raise exception 'Commercial total is outside the supported integer range'
      using errcode = '22003';
  end if;

  if v_total_cost_bigint < 0 or v_total_cost_bigint > 2147483647 then
    raise exception 'Total cost is outside the supported integer range'
      using errcode = '22003';
  end if;

  v_commercial_total := v_commercial_total_bigint::integer;
  v_total_cost := v_total_cost_bigint::integer;

  -- Reuse the existing atomic sale implementation for stock and movement.
  v_sale := public.register_sale(
    v_order.product_id,
    v_order.quantity,
    v_order.base_unit_price,
    'Transferencia',
    concat('Pedido ', v_order.id, ' - ', v_order.customer_name)
  );

  -- Preserve the base unit snapshot and represent extras separately. Shipping
  -- is intentionally excluded from revenue, cost and gross profit.
  update public.sales as s
  set
    unit_price = v_order.base_unit_price,
    unit_cost = v_product.cost_price,
    extra_quantity = v_order.extra_quantity,
    extra_unit_price = v_order.extra_unit_price,
    total_amount = v_commercial_total,
    total_cost = v_total_cost,
    gross_profit = v_commercial_total - v_total_cost
  where s.id = v_sale.id
    and s.organization_id = v_order.organization_id
  returning s.* into v_sale;

  if not found then
    raise exception 'Registered sale could not be updated'
      using errcode = 'P0002';
  end if;

  perform pg_catalog.set_config('app.inventory_operation', 'register_sale', true);
  perform pg_catalog.set_config(
    'app.inventory_organization_id',
    v_order.organization_id::text,
    true
  );

  update public.orders as o
  set
    sale_id = v_sale.id,
    shipping_cost = 0
  where o.id = v_order.id
    and o.organization_id = v_order.organization_id
    and o.sale_id is null;

  if not found then
    raise exception 'Order was already registered as a sale'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('app.inventory_operation', '', true);
  perform pg_catalog.set_config('app.inventory_organization_id', '', true);

  return query
  select
    v_order.id,
    v_sale.id,
    v_commercial_total,
    v_sale.created_at;
end
$$;

revoke all on function public.register_order_sale(uuid) from public, anon;
grant execute on function public.register_order_sale(uuid) to authenticated;

comment on function public.register_order_sale(uuid) is
  'Atomically converts one tenant-owned non-cancelled order into one sale by reusing register_sale. Shipping is excluded; extras are revenue without separate extra cost.';

commit;
