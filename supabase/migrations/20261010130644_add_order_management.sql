-- Order management: product configuration, tenant-aware orders and RLS.
-- Apply only after the three 20260903 multi-tenant migrations.

begin;

do $$
begin
  if to_regprocedure('public.is_organization_member(uuid)') is null then
    raise exception 'Expected public.is_organization_member(uuid) was not found';
  end if;

  if to_regprocedure('public.has_organization_role(uuid,text[])') is null then
    raise exception 'Expected public.has_organization_role(uuid, text[]) was not found';
  end if;
end
$$;

alter table public.products
  add column allow_custom_extras boolean not null default false,
  add column extra_unit_price integer not null default 0,
  add column default_contents text,
  add constraint products_extra_unit_price_nonnegative_check
    check (extra_unit_price >= 0);

comment on column public.products.allow_custom_extras is
  'Whether an order for this product may include free-text custom extras.';

comment on column public.products.extra_unit_price is
  'Current suggested unit price for custom extras; copied into each order as a snapshot.';

comment on column public.products.default_contents is
  'Current description of what the base product includes; copied into each order as a snapshot.';

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  created_by uuid not null references auth.users(id),
  quantity integer not null default 1,
  base_unit_price integer not null,
  base_contents text,
  extra_quantity integer not null default 0,
  extra_unit_price integer not null default 0,
  extra_details text,
  shipping_cost integer not null default 0,
  total_amount integer generated always as (
    (base_unit_price * quantity)
    + (extra_quantity * extra_unit_price)
    + shipping_cost
  ) stored,
  customer_name text not null,
  customer_phone text,
  customer_email text,
  shipping_type text not null,
  shipping_address text,
  shipping_commune text,
  shipping_region text,
  blue_express_branch text,
  tracking_number text,
  order_status text not null default 'pending',
  payment_status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_organization_id_fkey
    foreign key (organization_id) references public.organizations(id),
  constraint orders_product_organization_fkey
    foreign key (product_id, organization_id)
    references public.products(id, organization_id),
  constraint orders_quantity_positive_check
    check (quantity > 0),
  constraint orders_base_unit_price_nonnegative_check
    check (base_unit_price >= 0),
  constraint orders_extra_quantity_nonnegative_check
    check (extra_quantity >= 0),
  constraint orders_extra_unit_price_nonnegative_check
    check (extra_unit_price >= 0),
  constraint orders_shipping_cost_nonnegative_check
    check (shipping_cost >= 0),
  constraint orders_total_amount_nonnegative_check
    check (total_amount >= 0),
  constraint orders_customer_name_present_check
    check (nullif(btrim(customer_name), '') is not null),
  constraint orders_shipping_type_check
    check (shipping_type in ('domicilio', 'sucursal')),
  constraint orders_shipping_destination_check
    check (
      (
        shipping_type = 'domicilio'
        and nullif(btrim(shipping_address), '') is not null
      )
      or (
        shipping_type = 'sucursal'
        and nullif(btrim(blue_express_branch), '') is not null
      )
    ),
  constraint orders_extra_details_check
    check (
      extra_quantity = 0
      or nullif(btrim(extra_details), '') is not null
    ),
  constraint orders_order_status_check
    check (
      order_status in (
        'pending',
        'preparing',
        'ready',
        'shipped',
        'delivered',
        'cancelled'
      )
    ),
  constraint orders_payment_status_check
    check (payment_status in ('pending', 'paid'))
);

alter table public.orders
  alter column total_amount set not null;

comment on table public.orders is
  'Tenant-owned order snapshots. Orders do not modify inventory or create sales.';

comment on column public.orders.base_unit_price is
  'Historical base unit price copied when the order is created.';

comment on column public.orders.base_contents is
  'Historical base contents copied when the order is created.';

comment on column public.orders.extra_unit_price is
  'Historical custom-extra unit price copied when the order is created.';

comment on column public.orders.total_amount is
  'Database-generated total: base price times quantity plus extras plus shipping.';

create index orders_organization_created_at_idx
  on public.orders(organization_id, created_at desc);

create index orders_organization_status_created_at_idx
  on public.orders(organization_id, order_status, created_at desc);

create index orders_product_organization_idx
  on public.orders(product_id, organization_id);

create index orders_created_by_idx
  on public.orders(created_by);

create function public.enforce_order_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.product_id is distinct from old.product_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'Order identity, tenant, product and creator are immutable'
      using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end
$$;

revoke all on function public.enforce_order_update() from public;

create trigger orders_enforce_update
  before update on public.orders
  for each row execute function public.enforce_order_update();

alter table public.orders enable row level security;

create policy orders_select_member
on public.orders
for select
to authenticated
using (public.is_organization_member(organization_id));

create policy orders_insert_member
on public.orders
for insert
to authenticated
with check (
  public.is_organization_member(organization_id)
  and created_by = (select auth.uid())
);

create policy orders_update_member
on public.orders
for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin', 'seller']::text[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin', 'seller']::text[]
  )
);

create policy orders_delete_admin
on public.orders
for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

revoke all on table public.orders from anon, authenticated;
grant select, insert, update, delete on table public.orders to authenticated;

commit;
