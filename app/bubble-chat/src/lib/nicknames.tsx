import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { getContactNicknames, setContactNickname } from './api';

// Private per-viewer aliases for other users (e.g. "saved as" names in groups).
// Resolution order is always: my saved nickname for them > their full_name > their username.

interface NicknameCtx {
  nicknames: Record<string, string>;
  getDisplayName: (u: any) => string;
  saveNickname: (contactId: string, nickname: string) => Promise<void>;
}

const NicknameContext = createContext<NicknameCtx>({
  nicknames: {},
  getDisplayName: (u: any) => u?.full_name || u?.name || u?.username || 'Unknown',
  saveNickname: async () => {},
});

// Plain module-level mirror of the nickname map, kept in sync by the provider below.
// Lets non-React singletons (e.g. chatCache.ts, which normalizes chat names outside
// any component) resolve a nickname synchronously without needing the context.
let nicknameCache: Record<string, string> = {};
export const getCachedNickname = (userId?: string | null): string | undefined =>
  userId ? nicknameCache[userId] : undefined;

export function NicknameProvider({ children }: { children: React.ReactNode }) {
  const [nicknames, setNicknames] = useState<Record<string, string>>({});

  useEffect(() => {
    getContactNicknames()
      .then((res: any) => { nicknameCache = res?.data || {}; setNicknames(nicknameCache); })
      .catch(() => {});
  }, []);

  const getDisplayName = useCallback((u: any) => {
    const id = u?._id || u?.id;
    return (id && nicknames[id]) || u?.full_name || u?.name || u?.username || 'Unknown';
  }, [nicknames]);

  const saveNickname = useCallback(async (contactId: string, nickname: string) => {
    const res: any = await setContactNickname(contactId, nickname);
    nicknameCache = res?.data || {};
    setNicknames(nicknameCache);
  }, []);

  return (
    <NicknameContext.Provider value={{ nicknames, getDisplayName, saveNickname }}>
      {children}
    </NicknameContext.Provider>
  );
}

export const useNicknames = () => useContext(NicknameContext);
