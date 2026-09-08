import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { getReadableError, type DbRow } from '../lib/schema';

export type Organization = {
  id: string;
  name: string;
  slug: string | null;
};

export type OrganizationMembership = {
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'seller';
  active: boolean;
};

const storageKeyPrefix = 'inventory.activeOrganizationId';

function storageKey(userId: string) {
  return `${storageKeyPrefix}.${userId}`;
}

function readStoredOrganizationId(userId: string) {
  try {
    return window.localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
}

function storeOrganizationId(userId: string, organizationId: string | null) {
  try {
    if (organizationId) {
      window.localStorage.setItem(storageKey(userId), organizationId);
    } else {
      window.localStorage.removeItem(storageKey(userId));
    }
  } catch {
    // The active organization still works for this session when storage is unavailable.
  }
}

function membershipFromRow(row: DbRow): OrganizationMembership | null {
  const organizationId = typeof row.organization_id === 'string' ? row.organization_id : '';
  const userId = typeof row.user_id === 'string' ? row.user_id : '';
  const role = row.role;

  if (
    !organizationId ||
    !userId ||
    (role !== 'owner' && role !== 'admin' && role !== 'seller')
  ) {
    return null;
  }

  return {
    organizationId,
    userId,
    role,
    active: row.active === true,
  };
}

function organizationFromRow(row: DbRow): Organization | null {
  const id = typeof row.id === 'string' ? row.id : '';
  const name = typeof row.name === 'string' ? row.name : '';

  if (!id || !name) return null;

  return {
    id,
    name,
    slug: typeof row.slug === 'string' ? row.slug : null,
  };
}

export function useOrganizationContext(userId: string | null) {
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [memberships, setMemberships] = useState<OrganizationMembership[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadOrganizations() {
      await Promise.resolve();
      if (cancelled) return;

      setActiveOrganizationId(null);
      setOrganizations([]);
      setMemberships([]);
      setError('');
      setResolvedUserId(null);

      if (!userId) {
        setLoading(false);
        return;
      }

      const currentUserId = userId;
      setLoading(true);

      try {
        const membershipsResult = await supabase
          .from('organization_members')
          .select('organization_id,user_id,role,active')
          .eq('user_id', currentUserId)
          .eq('active', true);

        if (membershipsResult.error) throw membershipsResult.error;

        const activeMemberships = ((membershipsResult.data ?? []) as DbRow[])
          .map(membershipFromRow)
          .filter((membership): membership is OrganizationMembership => Boolean(membership));

        const organizationIds = activeMemberships.map(
          (membership) => membership.organizationId,
        );

        if (organizationIds.length === 0) {
          if (cancelled) return;
          setMemberships([]);
          setOrganizations([]);
          setActiveOrganizationId(null);
          storeOrganizationId(currentUserId, null);
          return;
        }

        const organizationsResult = await supabase
          .from('organizations')
          .select('id,name,slug')
          .in('id', organizationIds)
          .order('name');

        if (organizationsResult.error) throw organizationsResult.error;

        const availableOrganizations = ((organizationsResult.data ?? []) as DbRow[])
          .map(organizationFromRow)
          .filter((organization): organization is Organization => Boolean(organization));

        if (cancelled) return;

        const availableIds = new Set(
          availableOrganizations.map((organization) => organization.id),
        );
        const validMemberships = activeMemberships.filter((membership) =>
          availableIds.has(membership.organizationId),
        );
        const storedOrganizationId = readStoredOrganizationId(currentUserId);
        const nextOrganizationId =
          storedOrganizationId && availableIds.has(storedOrganizationId)
            ? storedOrganizationId
            : availableOrganizations[0]?.id ?? null;

        setMemberships(validMemberships);
        setOrganizations(availableOrganizations);
        setActiveOrganizationId(nextOrganizationId);
        storeOrganizationId(currentUserId, nextOrganizationId);
      } catch (loadError) {
        if (cancelled) return;
        setMemberships([]);
        setOrganizations([]);
        setActiveOrganizationId(null);
        setError(getReadableError(loadError));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setResolvedUserId(currentUserId);
        }
      }
    }

    void loadOrganizations();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const activeOrganization = useMemo(
    () =>
      organizations.find((organization) => organization.id === activeOrganizationId) ?? null,
    [activeOrganizationId, organizations],
  );

  const setActiveOrganization = useCallback(
    (organizationId: string) => {
      if (!userId || !organizations.some((organization) => organization.id === organizationId)) {
        return;
      }

      setActiveOrganizationId(organizationId);
      storeOrganizationId(userId, organizationId);
    },
    [organizations, userId],
  );

  return {
    activeOrganizationId,
    activeOrganization,
    organizations,
    memberships,
    setActiveOrganization,
    loading: Boolean(userId) && (loading || resolvedUserId !== userId),
    error,
  };
}
