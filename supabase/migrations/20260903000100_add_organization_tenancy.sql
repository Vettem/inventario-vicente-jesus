-- Migration 1/3: organization model, backfill and tenant-aware constraints.
-- Review supabase/inspection/inspect_current_database.sql output first.

begin;

do $$
declare
  v_missing text;
  v_invalid_members bigint;
begin
  select string_agg(required.table_name || '.' || required.column_name, ', ')
  into v_missing
  from (
    values
      ('members', 'user_id'),
      ('members', 'display_name'),
      ('members', 'active'),
      ('members', 'created_at'),
      ('products', 'id'),
      ('products', 'sku'),
      ('products', 'created_by'),
      ('products', 'stock'),
      ('sales', 'id'),
      ('sales', 'product_id'),
      ('sales', 'seller_id'),
      ('sales', 'created_at'),
      ('inventory_movements', 'product_id'),
      ('inventory_movements', 'sale_id'),
      ('inventory_movements', 'performed_by'),
      ('inventory_movements', 'created_at'),
      ('expenses', 'paid_by'),
      ('expenses', 'created_at')
  ) as required(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns as c
    where c.table_schema = 'public'
      and c.table_name = required.table_name
      and c.column_name = required.column_name
  );

  if v_missing is not null then
    raise exception
      'Multi-tenant migration aborted. Required columns are missing: %',
      v_missing;
  end if;

  select count(*)
  into v_invalid_members
  from public.members as m
  left join auth.users as u on u.id = m.user_id
  where m.user_id is null or u.id is null;

  if v_invalid_members > 0 then
    raise exception
      'Multi-tenant migration aborted. % members rows do not reference a valid auth.users row.',
      v_invalid_members;
  end if;

  if not exists (
    select 1
    from public.members as m
    join auth.users as u on u.id = m.user_id
    where m.active is true
  ) then
    raise exception
      'Multi-tenant migration aborted. No active member with a valid auth.users row can own JeVi.';
  end if;
end
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  role text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  constraint organization_members_role_check
    check (role in ('owner', 'admin', 'seller'))
);

alter table public.products
  add column organization_id uuid;

alter table public.sales
  add column organization_id uuid;

alter table public.inventory_movements
  add column organization_id uuid;

alter table public.expenses
  add column organization_id uuid;

do $$
declare
  v_owner_id uuid;
  v_organization_id uuid;
begin
  select m.user_id
  into v_owner_id
  from public.members as m
  join auth.users as u on u.id = m.user_id
  where m.active is true
  order by m.created_at asc nulls last, m.user_id asc
  limit 1;

  if v_owner_id is null then
    raise exception
      'Multi-tenant migration aborted. Unable to select a valid owner for JeVi.';
  end if;

  insert into public.organizations (name, slug, created_by)
  values ('JeVi', 'jevi', v_owner_id)
  returning id into v_organization_id;

  insert into public.organization_members (
    organization_id,
    user_id,
    role,
    active
  )
  select
    v_organization_id,
    m.user_id,
    case when m.user_id = v_owner_id then 'owner' else 'admin' end,
    bool_or(m.active)
  from public.members as m
  group by m.user_id;

  update public.products
  set organization_id = v_organization_id
  where organization_id is null;

  update public.sales
  set organization_id = v_organization_id
  where organization_id is null;

  update public.inventory_movements
  set organization_id = v_organization_id
  where organization_id is null;

  update public.expenses
  set organization_id = v_organization_id
  where organization_id is null;
end
$$;

do $$
declare
  v_products_null bigint;
  v_sales_null bigint;
  v_movements_null bigint;
  v_expenses_null bigint;
begin
  select count(*) into v_products_null
  from public.products where organization_id is null;

  select count(*) into v_sales_null
  from public.sales where organization_id is null;

  select count(*) into v_movements_null
  from public.inventory_movements where organization_id is null;

  select count(*) into v_expenses_null
  from public.expenses where organization_id is null;

  if v_products_null <> 0
    or v_sales_null <> 0
    or v_movements_null <> 0
    or v_expenses_null <> 0 then
    raise exception
      'Backfill incomplete. NULL organization_id counts: products=%, sales=%, inventory_movements=%, expenses=%',
      v_products_null,
      v_sales_null,
      v_movements_null,
      v_expenses_null;
  end if;
end
$$;

alter table public.products
  alter column organization_id set not null,
  add constraint products_organization_id_fkey
    foreign key (organization_id) references public.organizations(id);

alter table public.sales
  alter column organization_id set not null,
  add constraint sales_organization_id_fkey
    foreign key (organization_id) references public.organizations(id);

alter table public.inventory_movements
  alter column organization_id set not null,
  add constraint inventory_movements_organization_id_fkey
    foreign key (organization_id) references public.organizations(id);

alter table public.expenses
  alter column organization_id set not null,
  add constraint expenses_organization_id_fkey
    foreign key (organization_id) references public.organizations(id);

-- Drop only UNIQUE constraints whose sole column is products.sku. The catalog
-- lookup avoids guessing the historical constraint name.
do $$
declare
  v_sku_attnum smallint;
  v_constraint record;
  v_index record;
begin
  select a.attnum
  into v_sku_attnum
  from pg_attribute as a
  where a.attrelid = 'public.products'::regclass
    and a.attname = 'sku'
    and not a.attisdropped;

  for v_constraint in
    select c.conname
    from pg_constraint as c
    where c.conrelid = 'public.products'::regclass
      and c.contype = 'u'
      and cardinality(c.conkey) = 1
      and c.conkey[1] = v_sku_attnum
  loop
    execute format(
      'alter table public.products drop constraint %I',
      v_constraint.conname
    );
  end loop;

  -- Handle a standalone global unique index, if the old uniqueness was not a
  -- table constraint. Partial and expression indexes are intentionally ignored.
  for v_index in
    select ni.nspname as schema_name, ci.relname as index_name
    from pg_index as i
    join pg_class as ci on ci.oid = i.indexrelid
    join pg_namespace as ni on ni.oid = ci.relnamespace
    where i.indrelid = 'public.products'::regclass
      and i.indisunique
      and i.indnkeyatts = 1
      and i.indexprs is null
      and i.indpred is null
      and not exists (
        select 1 from pg_constraint as c where c.conindid = i.indexrelid
      )
      and exists (
        select 1
        from unnest(i.indkey) with ordinality as key_column(attnum, position)
        where key_column.position = 1
          and key_column.attnum = v_sku_attnum
      )
  loop
    execute format(
      'drop index %I.%I',
      v_index.schema_name,
      v_index.index_name
    );
  end loop;
end
$$;

alter table public.products
  add constraint products_organization_id_sku_key
    unique (organization_id, sku),
  add constraint products_id_organization_id_key
    unique (id, organization_id);

alter table public.sales
  add constraint sales_id_organization_id_key
    unique (id, organization_id),
  add constraint sales_product_organization_fkey
    foreign key (product_id, organization_id)
    references public.products(id, organization_id);

alter table public.inventory_movements
  add constraint inventory_movements_product_organization_fkey
    foreign key (product_id, organization_id)
    references public.products(id, organization_id),
  add constraint inventory_movements_sale_organization_fkey
    foreign key (sale_id, organization_id)
    references public.sales(id, organization_id);

-- The composite indexes below also cover organization_id-only lookups, so
-- separate single-column indexes would be redundant.
create index organization_members_user_id_idx
  on public.organization_members(user_id);

create index sales_organization_created_at_idx
  on public.sales(organization_id, created_at);

create index expenses_organization_created_at_idx
  on public.expenses(organization_id, created_at);

create index inventory_movements_organization_created_at_idx
  on public.inventory_movements(organization_id, created_at);

-- Reuse a recognizable products.updated_at trigger helper when exactly one is
-- present. Otherwise create one narrowly scoped helper for organizations.
do $$
declare
  v_function_oid oid;
  v_match_count integer;
begin
  select
    count(distinct t.tgfoid),
    (array_agg(distinct t.tgfoid))[1]
  into v_match_count, v_function_oid
  from pg_trigger as t
  where t.tgrelid = 'public.products'::regclass
    and not t.tgisinternal
    and pg_get_functiondef(t.tgfoid) ilike '%updated_at%'
    and pg_get_functiondef(t.tgfoid) not ilike '%tg_argv%';

  if v_match_count > 1 then
    raise exception
      'Multiple products updated_at trigger helpers were found. Review them before applying organizations.updated_at automation.';
  elsif v_match_count = 1 then
    execute format(
      'create trigger organizations_set_updated_at before update on public.organizations for each row execute function %s',
      v_function_oid::regprocedure
    );
  else
    execute $definition$
      create function public.set_multi_tenant_updated_at()
      returns trigger
      language plpgsql
      set search_path = ''
      as $body$
      begin
        new.updated_at := now();
        return new;
      end
      $body$
    $definition$;

    create trigger organizations_set_updated_at
      before update on public.organizations
      for each row execute function public.set_multi_tenant_updated_at();
  end if;
end
$$;

comment on table public.organizations is
  'Tenant/business boundary for shared inventory data.';

comment on table public.organization_members is
  'Active user memberships and roles for organizations.';

commit;
