-- Read-only post-migration validation.
-- Every result set should be reviewed. No statement in this file changes data.

begin transaction read only;

-- A. All four tenant-owned tables must report zero NULL organization_id rows.
select 'products' as table_name, count(*) as null_organization_ids
from public.products where organization_id is null
union all
select 'sales', count(*)
from public.sales where organization_id is null
union all
select 'inventory_movements', count(*)
from public.inventory_movements where organization_id is null
union all
select 'expenses', count(*)
from public.expenses where organization_id is null;

-- B1. Exactly one migrated JeVi organization should exist.
select count(*) as jevi_organization_count
from public.organizations
where name = 'JeVi' and slug = 'jevi';

-- B2. Every pre-existing tenant-owned row should now point to JeVi. These four
-- counts must all be zero immediately after migration and before adding Org B data.
select 'products' as table_name, count(*) as rows_outside_jevi
from public.products as row_data
where not exists (
  select 1 from public.organizations as o
  where o.id = row_data.organization_id
    and o.name = 'JeVi'
    and o.slug = 'jevi'
)
union all
select 'sales', count(*)
from public.sales as row_data
where not exists (
  select 1 from public.organizations as o
  where o.id = row_data.organization_id
    and o.name = 'JeVi'
    and o.slug = 'jevi'
)
union all
select 'inventory_movements', count(*)
from public.inventory_movements as row_data
where not exists (
  select 1 from public.organizations as o
  where o.id = row_data.organization_id
    and o.name = 'JeVi'
    and o.slug = 'jevi'
)
union all
select 'expenses', count(*)
from public.expenses as row_data
where not exists (
  select 1 from public.organizations as o
  where o.id = row_data.organization_id
    and o.name = 'JeVi'
    and o.slug = 'jevi'
);

-- C. Every current members user must have a JeVi membership. Result: zero.
select count(*) as members_missing_jevi_membership
from public.members as m
where not exists (
  select 1
  from public.organization_members as om
  join public.organizations as o on o.id = om.organization_id
  where om.user_id = m.user_id
    and o.name = 'JeVi'
    and o.slug = 'jevi'
);

-- D. Sales may not reference a product from another organization. Result: zero.
select count(*) as cross_tenant_sales
from public.sales as s
join public.products as p on p.id = s.product_id
where s.organization_id <> p.organization_id;

-- E. Movements may not reference a product from another organization. Result: zero.
select count(*) as cross_tenant_movement_products
from public.inventory_movements as im
join public.products as p on p.id = im.product_id
where im.organization_id <> p.organization_id;

-- F. A linked movement sale must belong to the same organization. Result: zero.
select count(*) as cross_tenant_movement_sales
from public.inventory_movements as im
join public.sales as s on s.id = im.sale_id
where im.sale_id is not null
  and im.organization_id <> s.organization_id;

-- G1. Duplicate non-NULL SKU values inside one organization. Result: no rows.
select organization_id, sku, count(*) as duplicate_count
from public.products
where sku is not null
group by organization_id, sku
having count(*) > 1;

-- G2. Cross-organization repeats are valid. This lists any that currently exist;
-- no rows is also valid until the same SKU is deliberately used in another org.
select sku, count(distinct organization_id) as organization_count
from public.products
where sku is not null
group by sku
having count(distinct organization_id) > 1;

-- G3. Confirm the effective UNIQUE definition is organization_id + sku.
select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid, true) as constraint_definition
from pg_constraint as c
where c.conrelid = 'public.products'::regclass
  and c.contype = 'u'
order by c.conname;

-- H. Active policies on every table involved in tenant isolation.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'organizations',
    'organization_members',
    'members',
    'products',
    'sales',
    'inventory_movements',
    'expenses'
  )
order by tablename, policyname;

-- The global members policy must be gone and the tenant-aware replacement must
-- exist exactly once.
select
  count(*) filter (
    where policyname = 'Members can view members'
  ) as obsolete_members_policy_count,
  count(*) filter (
    where policyname = 'members_select_self_or_shared_organization'
  ) as tenant_members_policy_count
from pg_policies
where schemaname = 'public'
  and tablename = 'members';

-- I. Organizations and memberships, with the profile display name when present.
select
  o.id as organization_id,
  o.name as organization_name,
  o.slug,
  om.user_id,
  m.display_name,
  om.role,
  om.active,
  om.created_at
from public.organizations as o
join public.organization_members as om on om.organization_id = o.id
left join public.members as m on m.user_id = om.user_id
order by o.name, om.role, m.display_name, om.user_id;

-- Additional constraint verification for all tenant-aware FKs.
select
  c.conrelid::regclass::text as table_name,
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid, true) as constraint_definition
from pg_constraint as c
where c.conname in (
  'products_organization_id_fkey',
  'products_organization_id_sku_key',
  'products_id_organization_id_key',
  'sales_organization_id_fkey',
  'sales_id_organization_id_key',
  'sales_product_organization_fkey',
  'inventory_movements_organization_id_fkey',
  'inventory_movements_product_organization_fkey',
  'inventory_movements_sale_organization_fkey',
  'expenses_organization_id_fkey',
  'organization_members_role_check'
)
order by table_name, constraint_name;

-- Confirm public RPC names are wrappers and legacy bodies are not executable by
-- anon/authenticated. The ACL column should not grant those roles on legacy RPCs.
select
  p.oid::regprocedure::text as function_signature,
  pg_get_function_result(p.oid) as return_type,
  p.pronargdefaults as default_argument_count,
  p.prosecdef as security_definer,
  p.proacl as access_control_list,
  p.proconfig as function_settings
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'register_stock_entry',
    'register_stock_output',
    'register_sale',
    'register_stock_entry_legacy_monotenant',
    'register_stock_output_legacy_monotenant',
    'register_sale_legacy_monotenant'
  )
order by p.proname;

-- Legacy implementations must not be callable by frontend roles. Public wrappers
-- must remain callable by authenticated and preserve their real return types.
select
  p.oid::regprocedure::text as function_signature,
  pg_get_function_result(p.oid) as return_type,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')
    as authenticated_can_execute
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'register_stock_entry',
    'register_stock_output',
    'register_sale',
    'register_stock_entry_legacy_monotenant',
    'register_stock_output_legacy_monotenant',
    'register_sale_legacy_monotenant'
  )
order by p.proname;

-- Confirm the global active-user helper still exists with its original meaning.
select pg_get_functiondef('public.is_active_member()'::regprocedure)
  as is_active_member_definition;

rollback;
