-- Migration 3/3: preserve the existing RPC bodies behind tenant-aware wrappers.
-- The wrappers keep the current frontend signatures unchanged.
-- Built against the inspected remote definitions and guarded by return/default/
-- SECURITY DEFINER preflight checks before any function is renamed.

begin;

do $$
declare
  v_named_function_count integer;
  v_function_oid oid;
begin
  if to_regprocedure(
    'public.register_stock_entry(uuid,integer,integer,text,text)'
  ) is null then
    raise exception 'Expected register_stock_entry(uuid, integer, integer, text, text) was not found';
  end if;

  if to_regprocedure(
    'public.register_stock_output(uuid,integer,text,text)'
  ) is null then
    raise exception 'Expected register_stock_output(uuid, integer, text, text) was not found';
  end if;

  if to_regprocedure(
    'public.register_sale(uuid,integer,integer,text,text)'
  ) is null then
    raise exception 'Expected register_sale(uuid, integer, integer, text, text) was not found';
  end if;

  if to_regprocedure('public.is_active_member()') is null then
    raise exception 'Expected public.is_active_member() was not found';
  end if;

  select count(*)
  into v_named_function_count
  from pg_proc as p
  join pg_namespace as n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'register_stock_entry',
      'register_stock_output',
      'register_sale'
    );

  if v_named_function_count <> 3 then
    raise exception
      'Expected exactly three inventory RPC overloads, found %. Review all overloads before migration.',
      v_named_function_count;
  end if;

  v_function_oid := to_regprocedure(
    'public.register_stock_entry(uuid,integer,integer,text,text)'
  );
  if (
    select p.prorettype <> 'public.products'::regtype
      or p.proretset
      or not p.prosecdef
      or p.pronargdefaults <> 3
      or p.proargnames <> array[
        'p_product_id',
        'p_quantity',
        'p_unit_cost',
        'p_movement_type',
        'p_notes'
      ]::text[]
    from pg_proc as p
    where p.oid = v_function_oid
  ) then
    raise exception
      'register_stock_entry must return one public.products row and use SECURITY DEFINER';
  end if;

  v_function_oid := to_regprocedure(
    'public.register_stock_output(uuid,integer,text,text)'
  );
  if (
    select p.prorettype <> 'public.products'::regtype
      or p.proretset
      or not p.prosecdef
      or p.pronargdefaults <> 2
      or p.proargnames <> array[
        'p_product_id',
        'p_quantity',
        'p_movement_type',
        'p_notes'
      ]::text[]
    from pg_proc as p
    where p.oid = v_function_oid
  ) then
    raise exception
      'register_stock_output must return one public.products row and use SECURITY DEFINER';
  end if;

  v_function_oid := to_regprocedure(
    'public.register_sale(uuid,integer,integer,text,text)'
  );
  if (
    select p.prorettype <> 'public.sales'::regtype
      or p.proretset
      or not p.prosecdef
      or p.pronargdefaults <> 3
      or p.proargnames <> array[
        'p_product_id',
        'p_quantity',
        'p_unit_price',
        'p_payment_method',
        'p_notes'
      ]::text[]
    from pg_proc as p
    where p.oid = v_function_oid
  ) then
    raise exception
      'register_sale must return one public.sales row and use SECURITY DEFINER';
  end if;

  v_function_oid := to_regprocedure('public.is_active_member()');
  if (
    select p.prorettype <> 'boolean'::regtype
      or p.proretset
      or not p.prosecdef
    from pg_proc as p
    where p.oid = v_function_oid
  ) then
    raise exception
      'is_active_member must return one boolean and use SECURITY DEFINER';
  end if;

  if to_regprocedure(
    'public.register_stock_entry_legacy_monotenant(uuid,integer,integer,text,text)'
  ) is not null
    or to_regprocedure(
      'public.register_stock_output_legacy_monotenant(uuid,integer,text,text)'
    ) is not null
    or to_regprocedure(
      'public.register_sale_legacy_monotenant(uuid,integer,integer,text,text)'
    ) is not null then
    raise exception 'A legacy_monotenant RPC already exists; migration state is unexpected';
  end if;
end
$$;

alter function public.register_stock_entry(uuid, integer, integer, text, text)
  rename to register_stock_entry_legacy_monotenant;

alter function public.register_stock_output(uuid, integer, text, text)
  rename to register_stock_output_legacy_monotenant;

alter function public.register_sale(uuid, integer, integer, text, text)
  rename to register_sale_legacy_monotenant;

alter function public.register_stock_entry_legacy_monotenant(
  uuid,
  integer,
  integer,
  text,
  text
) set search_path = '';

alter function public.register_stock_output_legacy_monotenant(
  uuid,
  integer,
  text,
  text
) set search_path = '';

alter function public.register_sale_legacy_monotenant(
  uuid,
  integer,
  integer,
  text,
  text
) set search_path = '';

revoke all on function public.register_stock_entry_legacy_monotenant(
  uuid,
  integer,
  integer,
  text,
  text
) from public, anon, authenticated;

revoke all on function public.register_stock_output_legacy_monotenant(
  uuid,
  integer,
  text,
  text
) from public, anon, authenticated;

revoke all on function public.register_sale_legacy_monotenant(
  uuid,
  integer,
  integer,
  text,
  text
) from public, anon, authenticated;

create function public.resolve_single_organization_for_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select array_agg(om.organization_id order by om.organization_id)
  into v_organization_ids
  from public.organization_members as om
  where om.user_id = v_user_id
    and om.active is true;

  if coalesce(cardinality(v_organization_ids), 0) = 0 then
    raise exception 'The authenticated user has no active organization membership'
      using errcode = '42501';
  end if;

  if cardinality(v_organization_ids) > 1 then
    raise exception 'organization_id is required when the user belongs to multiple organizations'
      using errcode = '22023';
  end if;

  return v_organization_ids[1];
end
$$;

comment on function public.resolve_single_organization_for_user() is
  'Temporary single-organization compatibility helper. The next frontend stage must send the selected organization_id explicitly.';

revoke all on function public.resolve_single_organization_for_user() from public;

create function public.enforce_product_tenant_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_operation text := current_setting('app.inventory_operation', true);
  v_context_organization_id text :=
    current_setting('app.inventory_organization_id', true);
begin
  if tg_op = 'INSERT' then
    if v_user_id is null then
      if new.organization_id is null or new.created_by is null then
        raise exception 'Database-level product inserts require organization_id and created_by';
      end if;
      return new;
    end if;

    if new.organization_id is null then
      new.organization_id := public.resolve_single_organization_for_user();
    end if;

    if not public.is_organization_member(new.organization_id) then
      raise exception 'The authenticated user is not an active member of this organization'
        using errcode = '42501';
    end if;

    new.created_by := v_user_id;

    if new.stock is null then
      new.stock := 0;
    elsif new.stock <> 0 then
      raise exception 'New products must start with stock 0'
        using errcode = '23514';
    end if;

    return new;
  end if;

  if new.stock is distinct from old.stock and v_user_id is not null then
    if v_operation is null or v_operation not in (
      'register_stock_entry',
      'register_stock_output',
      'register_sale'
    ) or v_context_organization_id is distinct from old.organization_id::text then
      raise exception 'Product stock can only be changed by an inventory RPC'
        using errcode = '42501';
    end if;

    if not public.is_organization_member(old.organization_id) then
      raise exception 'The authenticated user is not an active member of this organization'
        using errcode = '42501';
    end if;
  end if;

  return new;
end
$$;

create trigger products_enforce_tenant_write
  before insert or update on public.products
  for each row execute function public.enforce_product_tenant_write();

create function public.enforce_sale_tenant_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_organization_id uuid;
  v_context_organization_id text :=
    current_setting('app.inventory_organization_id', true);
begin
  select p.organization_id
  into v_product_organization_id
  from public.products as p
  where p.id = new.product_id;

  if v_product_organization_id is null then
    raise exception 'The sale product does not exist' using errcode = '23503';
  end if;

  if new.organization_id is not null
    and new.organization_id <> v_product_organization_id then
    raise exception 'Sale and product must belong to the same organization'
      using errcode = '23514';
  end if;

  new.organization_id := v_product_organization_id;

  if v_user_id is not null then
    if current_setting('app.inventory_operation', true) <> 'register_sale'
      or v_context_organization_id is distinct from v_product_organization_id::text then
      raise exception 'Sales must be created through register_sale'
        using errcode = '42501';
    end if;

    if not public.is_organization_member(v_product_organization_id) then
      raise exception 'The authenticated user is not an active member of this organization'
        using errcode = '42501';
    end if;

    new.seller_id := v_user_id;
  end if;

  return new;
end
$$;

create trigger sales_enforce_tenant_write
  before insert on public.sales
  for each row execute function public.enforce_sale_tenant_write();

create function public.enforce_movement_tenant_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_organization_id uuid;
  v_sale_organization_id uuid;
  v_operation text := current_setting('app.inventory_operation', true);
  v_context_organization_id text :=
    current_setting('app.inventory_organization_id', true);
begin
  select p.organization_id
  into v_product_organization_id
  from public.products as p
  where p.id = new.product_id;

  if v_product_organization_id is null then
    raise exception 'The movement product does not exist' using errcode = '23503';
  end if;

  if new.organization_id is not null
    and new.organization_id <> v_product_organization_id then
    raise exception 'Movement and product must belong to the same organization'
      using errcode = '23514';
  end if;

  if new.sale_id is not null then
    select s.organization_id
    into v_sale_organization_id
    from public.sales as s
    where s.id = new.sale_id;

    if v_sale_organization_id is null then
      raise exception 'The movement sale does not exist' using errcode = '23503';
    end if;

    if v_sale_organization_id <> v_product_organization_id then
      raise exception 'Movement, sale and product must belong to the same organization'
        using errcode = '23514';
    end if;
  end if;

  new.organization_id := v_product_organization_id;

  if v_user_id is not null then
    if v_operation not in (
      'register_stock_entry',
      'register_stock_output',
      'register_sale'
    ) or v_context_organization_id is distinct from v_product_organization_id::text then
      raise exception 'Inventory movements must be created through an inventory RPC'
        using errcode = '42501';
    end if;

    if not public.is_organization_member(v_product_organization_id) then
      raise exception 'The authenticated user is not an active member of this organization'
        using errcode = '42501';
    end if;

    new.performed_by := v_user_id;
  end if;

  return new;
end
$$;

create trigger inventory_movements_enforce_tenant_write
  before insert on public.inventory_movements
  for each row execute function public.enforce_movement_tenant_write();

create function public.enforce_expense_tenant_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if tg_op = 'INSERT' and v_user_id is not null then
    if new.organization_id is null then
      new.organization_id := public.resolve_single_organization_for_user();
    end if;

    if not public.is_organization_member(new.organization_id) then
      raise exception 'The authenticated user is not an active member of this organization'
        using errcode = '42501';
    end if;

    new.paid_by := v_user_id;
  end if;

  return new;
end
$$;

create trigger expenses_enforce_tenant_write
  before insert or update on public.expenses
  for each row execute function public.enforce_expense_tenant_write();

revoke all on function public.enforce_product_tenant_write() from public;
revoke all on function public.enforce_sale_tenant_write() from public;
revoke all on function public.enforce_movement_tenant_write() from public;
revoke all on function public.enforce_expense_tenant_write() from public;

create function public.register_stock_entry(
  p_product_id uuid,
  p_quantity integer,
  p_unit_cost integer default null,
  p_movement_type text default 'purchase',
  p_notes text default null
)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_result public.products;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not public.is_active_member() then
    raise exception 'User is not globally active' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative' using errcode = '22023';
  end if;

  if p_movement_type not in (
    'initial_stock',
    'purchase',
    'return',
    'adjustment_in'
  ) then
    raise exception 'Invalid stock-entry movement type' using errcode = '22023';
  end if;

  select p.organization_id
  into v_organization_id
  from public.products as p
  where p.id = p_product_id
  for update;

  if v_organization_id is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  if not public.is_organization_member(v_organization_id) then
    raise exception 'The authenticated user is not an active member of this organization'
      using errcode = '42501';
  end if;

  perform pg_catalog.set_config(
    'app.inventory_operation',
    'register_stock_entry',
    true
  );
  perform pg_catalog.set_config(
    'app.inventory_organization_id',
    v_organization_id::text,
    true
  );

  v_result := public.register_stock_entry_legacy_monotenant(
    p_product_id,
    p_quantity,
    p_unit_cost,
    p_movement_type,
    p_notes
  );

  perform pg_catalog.set_config('app.inventory_operation', '', true);
  perform pg_catalog.set_config('app.inventory_organization_id', '', true);

  return v_result;
end
$$;

create function public.register_stock_output(
  p_product_id uuid,
  p_quantity integer,
  p_movement_type text default 'damaged',
  p_notes text default null
)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_result public.products;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not public.is_active_member() then
    raise exception 'User is not globally active' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  if p_movement_type not in ('damaged', 'adjustment_out') then
    raise exception 'Invalid stock-output movement type' using errcode = '22023';
  end if;

  select p.organization_id
  into v_organization_id
  from public.products as p
  where p.id = p_product_id
  for update;

  if v_organization_id is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  if not public.is_organization_member(v_organization_id) then
    raise exception 'The authenticated user is not an active member of this organization'
      using errcode = '42501';
  end if;

  perform pg_catalog.set_config(
    'app.inventory_operation',
    'register_stock_output',
    true
  );
  perform pg_catalog.set_config(
    'app.inventory_organization_id',
    v_organization_id::text,
    true
  );

  v_result := public.register_stock_output_legacy_monotenant(
    p_product_id,
    p_quantity,
    p_movement_type,
    p_notes
  );

  perform pg_catalog.set_config('app.inventory_operation', '', true);
  perform pg_catalog.set_config('app.inventory_organization_id', '', true);

  return v_result;
end
$$;

create function public.register_sale(
  p_product_id uuid,
  p_quantity integer,
  p_unit_price integer default null,
  p_payment_method text default 'Transferencia',
  p_notes text default null
)
returns public.sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_result public.sales;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not public.is_active_member() then
    raise exception 'User is not globally active' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  if p_unit_price is not null and p_unit_price < 0 then
    raise exception 'Unit price cannot be negative' using errcode = '22023';
  end if;

  select p.organization_id
  into v_organization_id
  from public.products as p
  where p.id = p_product_id
  for update;

  if v_organization_id is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  if not public.is_organization_member(v_organization_id) then
    raise exception 'The authenticated user is not an active member of this organization'
      using errcode = '42501';
  end if;

  perform pg_catalog.set_config(
    'app.inventory_operation',
    'register_sale',
    true
  );
  perform pg_catalog.set_config(
    'app.inventory_organization_id',
    v_organization_id::text,
    true
  );

  v_result := public.register_sale_legacy_monotenant(
    p_product_id,
    p_quantity,
    p_unit_price,
    p_payment_method,
    p_notes
  );

  perform pg_catalog.set_config('app.inventory_operation', '', true);
  perform pg_catalog.set_config('app.inventory_organization_id', '', true);

  return v_result;
end
$$;

revoke all on function public.register_stock_entry(
  uuid,
  integer,
  integer,
  text,
  text
) from public, anon;

revoke all on function public.register_stock_output(
  uuid,
  integer,
  text,
  text
) from public, anon;

revoke all on function public.register_sale(
  uuid,
  integer,
  integer,
  text,
  text
) from public, anon;

grant execute on function public.register_stock_entry(
  uuid,
  integer,
  integer,
  text,
  text
) to authenticated;

grant execute on function public.register_stock_output(
  uuid,
  integer,
  text,
  text
) to authenticated;

grant execute on function public.register_sale(
  uuid,
  integer,
  integer,
  text,
  text
) to authenticated;

comment on function public.register_stock_entry(uuid, integer, integer, text, text) is
  'Tenant-aware authenticated wrapper returning the products row from the preserved stock-entry implementation.';

comment on function public.register_stock_output(uuid, integer, text, text) is
  'Tenant-aware authenticated wrapper returning the products row from the preserved stock-output implementation.';

comment on function public.register_sale(uuid, integer, integer, text, text) is
  'Tenant-aware authenticated wrapper returning the sales row from the preserved atomic sale implementation.';

commit;
