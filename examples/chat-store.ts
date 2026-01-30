/**
 * Persistent Chat Store Example
 *
 * This example shows how to create a persistent chat store
 * with automatic context recovery.
 */

import {
  createPersistStore,
  indexedDBStorage,
  mergeSessions,
  Session,
} from "../src";

// Define chat message type
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  date: Date;
}

// Define chat session type
interface ChatSession extends Session {
  id: string;
  topic: string;
  messages: ChatMessage[];
  lastUpdate: Date;
}

// Define store state
interface ChatState {
  sessions: ChatSession[];
  currentSessionId: string | null;
}

// Create the persistent chat store
const useChatStore = createPersistStore<
  ChatState,
  {
    createSession: (topic?: string) => string;
    deleteSession: (id: string) => void;
    addMessage: (sessionId: string, message: Omit<ChatMessage, "id" | "date">) => void;
    setCurrentSession: (id: string) => void;
    syncWithRemote: (remoteSessions: ChatSession[]) => void;
  }
>(
  // Initial state
  {
    sessions: [],
    currentSessionId: null,
  },
  // Methods
  (set, get) => ({
    createSession: (topic = "New Chat") => {
      const id = `session-${Date.now()}`;
      const newSession: ChatSession = {
        id,
        topic,
        messages: [],
        lastUpdate: new Date(),
      };
      set({
        sessions: [newSession, ...get().sessions],
        currentSessionId: id,
      });
      return id;
    },

    deleteSession: (id: string) => {
      const { sessions, currentSessionId } = get();
      const newSessions = sessions.filter((s) => s.id !== id);
      set({
        sessions: newSessions,
        currentSessionId:
          currentSessionId === id
            ? newSessions[0]?.id ?? null
            : currentSessionId,
      });
    },

    addMessage: (sessionId: string, message: Omit<ChatMessage, "id" | "date">) => {
      const sessions = get().sessions.map((session) => {
        if (session.id !== sessionId) return session;
        return {
          ...session,
          messages: [
            ...session.messages,
            {
              ...message,
              id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              date: new Date(),
            },
          ],
          lastUpdate: new Date(),
        };
      });
      set({ sessions });
    },

    setCurrentSession: (id: string) => {
      set({ currentSessionId: id });
    },

    syncWithRemote: (remoteSessions: ChatSession[]) => {
      const { sessions } = get();
      const mergedSessions = mergeSessions(
        sessions,
        remoteSessions,
      ) as ChatSession[];
      set({ sessions: mergedSessions });
    },
  }),
  // Persist options
  {
    name: "chat-store",
    version: 1,
  },
  // Use IndexedDB storage
  indexedDBStorage,
);

// Usage example
async function main() {
  const store = useChatStore.getState();

  // Wait for hydration
  if (!store._hasHydrated) {
    console.log("Waiting for state to hydrate...");
    await new Promise<void>((resolve) => {
      const unsubscribe = useChatStore.subscribe((state) => {
        if (state._hasHydrated) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  console.log("State hydrated! Existing sessions:", store.sessions.length);

  // Create a new session
  const sessionId = store.createSession("Test Chat");
  console.log("Created session:", sessionId);

  // Add a message
  store.addMessage(sessionId, {
    role: "user",
    content: "Hello, world!",
  });

  console.log("Current sessions:", useChatStore.getState().sessions);
}

main().catch(console.error);
