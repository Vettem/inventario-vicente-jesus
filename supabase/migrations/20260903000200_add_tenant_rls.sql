-- Migration 2/3: tenant membership helpers, RLS and policies.
-- Apply only after 20260903000100_add_organization_tenancy.sql.

begin;

create function public.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as om
    where om.organization_id = p_organization_id
      and om.user_id = auth.uid()
      and om.active is true
  ) and public.is_active_member();
$$;

comment on function public.is_organization_member(uuid) is
  'SECURITY DEFINER avoids recursive RLS and requires both global activation and an active organization membership for auth.uid().';

create function public.has_organization_role(
  p_organization_id uuid,
  p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as om
    where om.organization_id = p_organization_id
      and om.user_id = auth.uid()
      and om.active is true
      and om.role = any(p_roles)
  ) and public.is_active_member();
$$;

comment on function public.has_organization_role(uuid, text[]) is
  'SECURITY DEFINER role check scoped to a globally active auth.uid(); used by membership and organization policies.';

create function public.shares_active_organization_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_member()
    and exists (
      select 1
      from public.organization_members as current_membership
      join public.organization_members as target_membership
        on target_membership.organization_id = current_membership.organization_id
      where current_membership.user_id = auth.uid()
        and current_membership.active is true
        and target_membership.user_id = p_user_id
        and target_membership.active is true
    );
$$;

comment on function public.shares_active_organization_with(uuid) is
  'Returns true when auth.uid() is globally active and shares an active organization membership with the target user.';

revoke all on function public.is_organization_member(uuid) from public;
revoke all on function public.has_organization_role(uuid, text[]) from public;
revoke all on function public.shares_active_organization_with(uuid) from public;
grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.has_organization_role(uuid, text[]) to authenticated;
grant execute on function public.shares_active_organization_with(uuid)
  to authenticated;

create function public.guard_organization_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_organization_id uuid;
  v_has_other_owner boolean;
  v_removes_active_owner boolean := false;
begin
  if tg_op = 'DELETE' then
    v_organization_id := old.organization_id;
  else
    v_organization_id := new.organization_id;
  end if;

  if tg_op = 'UPDATE'
    and (
      new.organization_id is distinct from old.organization_id
      or new.user_id is distinct from old.user_id
    ) then
    raise exception 'organization_id and user_id are immutable membership keys'
      using errcode = '23514';
  end if;

  -- Admins may manage admins/sellers, but only an owner may create, modify or
  -- remove another owner membership.
  if v_actor_id is not null then
    if tg_op = 'UPDATE' or tg_op = 'DELETE' then
      if old.role = 'owner'
        and not public.has_organization_role(
          old.organization_id,
          array['owner']::text[]
        ) then
        raise exception 'Only an owner may modify an owner membership'
          using errcode = '42501';
      end if;
    end if;

    if tg_op = 'INSERT' or tg_op = 'UPDATE' then
      if new.role = 'owner'
        and not public.has_organization_role(
          new.organization_id,
          array['owner']::text[]
        ) then
        raise exception 'Only an owner may grant the owner role'
          using errcode = '42501';
      end if;
    end if;
  end if;

  -- Never allow an operation to remove, deactivate or demote the final owner.
  if tg_op = 'DELETE' then
    v_removes_active_owner := old.role = 'owner' and old.active is true;
  elsif tg_op = 'UPDATE' then
    v_removes_active_owner := old.role = 'owner'
      and old.active is true
      and (new.role <> 'owner' or new.active is not true);
  end if;

  if v_removes_active_owner then
      select exists (
        select 1
        from public.organization_members as om
        where om.organization_id = old.organization_id
          and om.user_id <> old.user_id
          and om.role = 'owner'
          and om.active is true
      )
      into v_has_other_owner;

      if not v_has_other_owner then
        raise exception 'An organization must retain at least one active owner'
          using errcode = '23514';
      end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end
$$;

revoke all on function public.guard_organization_membership() from public;

create trigger organization_members_guard_changes
  before insert or update or delete on public.organization_members
  for each row execute function public.guard_organization_membership();

create function public.protect_tenant_identity_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'organizations' then
    if new.id is distinct from old.id
      or new.created_by is distinct from old.created_by then
      raise exception 'Organization identity columns are immutable'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'products' then
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.created_by is distinct from old.created_by then
      raise exception 'Product identity and tenant columns are immutable'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'expenses' then
    if new.organization_id is distinct from old.organization_id
      or new.paid_by is distinct from old.paid_by then
      raise exception 'Expense tenant and actor columns are immutable'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

revoke all on function public.protect_tenant_identity_columns() from public;

create trigger organizations_protect_identity
  before update on public.organizations
  for each row execute function public.protect_tenant_identity_columns();

create trigger products_protect_identity
  before update on public.products
  for each row execute function public.protect_tenant_identity_columns();

create trigger expenses_protect_identity
  before update on public.expenses
  for each row execute function public.protect_tenant_identity_columns();

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.members enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.expenses enable row level security;

-- Replace policies on the tenant-owned tables. The inspection report must be
-- reviewed first because historical policy names and expressions are remote-only.
do $$
declare
  v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'organizations',
        'organization_members',
        'products',
        'sales',
        'inventory_movements',
        'expenses'
      )
  loop
    execute format(
      'drop policy %I on %I.%I',
      v_policy.policyname,
      v_policy.schemaname,
      v_policy.tablename
    );
  end loop;
end
$$;

-- Replace the confirmed global profile-visibility policy. Other members policies,
-- such as self-management rules, are preserved.
drop policy "Members can view members" on public.members;

create policy members_select_self_or_shared_organization
on public.members
for select
to authenticated
using (
  user_id = auth.uid()
  or public.shares_active_organization_with(user_id)
);

create policy organizations_select_member
on public.organizations
for select
to authenticated
using (public.is_organization_member(id));

create policy organizations_update_admin
on public.organizations
for update
to authenticated
using (
  public.has_organization_role(id, array['owner', 'admin']::text[])
)
with check (
  public.has_organization_role(id, array['owner', 'admin']::text[])
);

create policy organization_members_select_same_organization
on public.organization_members
for select
to authenticated
using (public.is_organization_member(organization_id));

create policy organization_members_insert_admin
on public.organization_members
for insert
to authenticated
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

create policy organization_members_update_admin
on public.organization_members
for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

create policy organization_members_delete_admin
on public.organization_members
for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

create policy products_select_member
on public.products
for select
to authenticated
using (public.is_organization_member(organization_id));

create policy products_insert_admin
on public.products
for insert
to authenticated
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
  and created_by = auth.uid()
  and stock = 0
);

create policy products_update_admin
on public.products
for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

create policy products_delete_admin
on public.products
for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

-- Sales and inventory movements are created only through the hardened RPCs.
create policy sales_select_member
on public.sales
for select
to authenticated
using (public.is_organization_member(organization_id));

create policy inventory_movements_select_member
on public.inventory_movements
for select
to authenticated
using (public.is_organization_member(organization_id));

create policy expenses_select_member
on public.expenses
for select
to authenticated
using (public.is_organization_member(organization_id));

create policy expenses_insert_admin
on public.expenses
for insert
to authenticated
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
  and paid_by = auth.uid()
);

create policy expenses_update_admin
on public.expenses
for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

create policy expenses_delete_admin
on public.expenses
for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['owner', 'admin']::text[]
  )
);

revoke all on table public.organizations from anon;
revoke all on table public.organization_members from anon;
revoke all on table public.organizations from authenticated;
revoke all on table public.organization_members from authenticated;

grant select, update on table public.organizations to authenticated;
grant select, insert, update, delete
  on table public.organization_members to authenticated;

commit;
