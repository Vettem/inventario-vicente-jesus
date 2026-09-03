-- Read-only inventory of the current Supabase schema.
-- Run this in Supabase SQL Editor BEFORE reviewing or applying the migrations.

begin transaction read only;

-- 1. Columns and defaults used by the migration.
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
from information_schema.columns as c
where c.table_schema = 'public'
  and c.table_name in (
    'members',
    'products',
    'sales',
    'inventory_movements',
    'expenses'
  )
order by c.table_name, c.ordinal_position;

-- 2. Exact definitions and security attributes of the three RPC functions and
-- the global active-member helper they rely on.
select
  p.oid::regprocedure::text as function_signature,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  p.proconfig as function_settings,
  pg_get_userbyid(p.proowner) as owner,
  pg_get_functiondef(p.oid) as function_definition
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'register_stock_entry',
    'register_stock_output',
    'register_sale',
    'is_active_member'
  )
order by p.proname, p.oid::regprocedure::text;

-- 2b. Other functions that call an inventory RPC by name. Review this before
-- renaming the original functions, even though the public wrapper names remain.
select
  p.oid::regprocedure::text as caller_signature,
  pg_get_functiondef(p.oid) as caller_definition
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname not in (
    'register_stock_entry',
    'register_stock_output',
    'register_sale'
  )
  and pg_get_functiondef(p.oid) ~* '\\m(register_stock_entry|register_stock_output|register_sale)\\M'
order by caller_signature;

-- 3. Current RLS state.
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class as c
join pg_namespace as n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'members',
    'products',
    'sales',
    'inventory_movements',
    'expenses'
  )
order by c.relname;

-- 4. Exact current policies.
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
    'members',
    'products',
    'sales',
    'inventory_movements',
    'expenses'
  )
order by tablename, policyname;

-- 5. Exact constraints, including the current global SKU constraint and FKs.
select
  c.conrelid::regclass::text as table_name,
  c.conname as constraint_name,
  c.contype as constraint_type,
  pg_get_constraintdef(c.oid, true) as constraint_definition
from pg_constraint as c
where c.connamespace = 'public'::regnamespace
  and c.conrelid in (
    'public.members'::regclass,
    'public.products'::regclass,
    'public.sales'::regclass,
    'public.inventory_movements'::regclass,
    'public.expenses'::regclass
  )
order by table_name, constraint_name;

-- 6. Current indexes, to detect redundant indexes before migration.
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'members',
    'products',
    'sales',
    'inventory_movements',
    'expenses'
  )
order by tablename, indexname;

-- 7. Triggers and their complete trigger-function definitions.
select
  t.tgrelid::regclass::text as table_name,
  t.tgname as trigger_name,
  pg_get_triggerdef(t.oid, true) as trigger_definition,
  t.tgfoid::regprocedure::text as trigger_function,
  pg_get_functiondef(t.tgfoid) as trigger_function_definition
from pg_trigger as t
where not t.tgisinternal
  and t.tgrelid in (
    'public.members'::regclass,
    'public.products'::regclass,
    'public.sales'::regclass,
    'public.inventory_movements'::regclass,
    'public.expenses'::regclass
  )
order by table_name, trigger_name;

-- 8. Other public functions whose source references the affected tables.
select
  p.oid::regprocedure::text as function_signature,
  p.prosecdef as security_definer,
  p.proconfig as function_settings,
  pg_get_functiondef(p.oid) as function_definition
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and (
    pg_get_functiondef(p.oid) ~* '\\m(products|sales|inventory_movements|expenses|members)\\M'
  )
order by function_signature;

-- 9. Existing grants on affected tables and functions.
select
  table_name,
  grantee,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'members',
    'products',
    'sales',
    'inventory_movements',
    'expenses'
  )
order by table_name, grantee, privilege_type;

select
  routine_name,
  grantee,
  privilege_type
from information_schema.role_routine_grants
where specific_schema = 'public'
  and routine_name in (
    'register_stock_entry',
    'register_stock_output',
    'register_sale'
  )
order by routine_name, grantee;

rollback;
