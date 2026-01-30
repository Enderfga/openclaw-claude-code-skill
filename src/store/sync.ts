/**
 * State Sync Utilities - Merge local and remote states
 */

/**
 * Deep merge utility
 */
export function merge<T extends object>(target: T, source: Partial<T>): T {
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue)
    ) {
      if (typeof targetValue !== "object" || targetValue === null) {
        (target as any)[key] = {};
      }
      merge(target[key] as object, sourceValue as object);
    } else if (sourceValue !== undefined) {
      (target as any)[key] = sourceValue;
    }
  }
  return target;
}

/**
 * Get non-function fields from an object
 */
export function getNonFunctionFields<T extends object>(obj: T) {
  const ret: any = {};

  Object.entries(obj).map(([k, v]) => {
    if (typeof v !== "function") {
      ret[k] = v;
    }
  });

  return ret;
}

/**
 * Merge state with lastUpdateTime - older state will be overridden
 */
export function mergeWithUpdate<T extends { lastUpdateTime?: number }>(
  localState: T,
  remoteState: T,
): T {
  const localUpdateTime = localState.lastUpdateTime ?? 0;
  const remoteUpdateTime = remoteState.lastUpdateTime ?? 1;

  if (localUpdateTime < remoteUpdateTime) {
    merge(remoteState, localState);
    return { ...remoteState };
  } else {
    merge(localState, remoteState);
    return { ...localState };
  }
}

/**
 * Session-like data structure for chat history
 */
export interface Session {
  id: string;
  messages: Array<{ id: string; date: string | Date; [key: string]: any }>;
  lastUpdate: string | Date;
  [key: string]: any;
}

/**
 * Merge sessions - combines messages from local and remote
 */
export function mergeSessions(
  localSessions: Session[],
  remoteSessions: Session[],
): Session[] {
  const localSessionMap: Record<string, Session> = {};
  localSessions.forEach((s) => (localSessionMap[s.id] = s));

  remoteSessions.forEach((remoteSession) => {
    // Skip empty chats
    if (remoteSession.messages.length === 0) return;

    const localSession = localSessionMap[remoteSession.id];
    if (!localSession) {
      // Remote session is new, add it
      localSessions.push(remoteSession);
    } else {
      // Both have same session id, merge messages
      const localMessageIds = new Set(localSession.messages.map((v) => v.id));
      remoteSession.messages.forEach((m) => {
        if (!localMessageIds.has(m.id)) {
          localSession.messages.push(m);
        }
      });

      // Sort messages by date ascending
      localSession.messages.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
    }
  });

  // Sort sessions by lastUpdate descending
  localSessions.sort(
    (a, b) =>
      new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime(),
  );

  return localSessions;
}

/**
 * Merge key-value stores - remote values first, then local overrides
 */
export function mergeKeyValueStore<T extends Record<string, any>>(
  localStore: T,
  remoteStore: T,
): T {
  return {
    ...remoteStore,
    ...localStore,
  };
}
