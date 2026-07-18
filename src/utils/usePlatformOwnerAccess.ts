import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { isPlatformOwner } from '../utils/companyHelpers';

/**
 * Resolves platform owner access using profile fields and DB RPCs (authoritative).
 */
export function usePlatformOwnerAccess(profile: Profile | null | undefined) {
  const [checking, setChecking] = useState(Boolean(profile));
  const [isOwner, setIsOwner] = useState(() => isPlatformOwner(profile ?? null));

  useEffect(() => {
    if (!profile) {
      setIsOwner(false);
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);

    void (async () => {
      const { data: sessionInfo } = await supabase.rpc('get_my_session_info');
      if (cancelled) return;

      const row = Array.isArray(sessionInfo) ? sessionInfo[0] : sessionInfo;
      if (row?.is_platform_owner === true) {
        setIsOwner(true);
        setChecking(false);
        return;
      }

      const { data: rpcOwner } = await supabase.rpc('is_platform_owner');
      if (cancelled) return;

      setIsOwner(rpcOwner === true || isPlatformOwner(profile));
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [profile?.id, profile?.email, profile?.is_platform_owner]);

  return { isOwner, checking };
}
