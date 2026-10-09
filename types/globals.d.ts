/**
 * Minimal ambient declarations for the extension APIs used in this project.
 * Keeping them local avoids a dependency on @types/chrome while still letting
 * `npm run typecheck` catch typos in the storage / messaging code.
 */

declare namespace chrome {
  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys: string | string[] | null, callback: (items: Record<string, any>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
      remove(keys: string | string[], callback?: () => void): void;
    }
    const sync: StorageArea;
    const local: StorageArea;
    const onChanged: {
      addListener(
        callback: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
      removeListener(
        callback: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
    };
  }

  namespace runtime {
    const lastError: { message?: string } | undefined;
    const id: string | undefined;
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
    const onMessage: {
      addListener(
        callback: (
          message: any,
          sender: any,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
    function sendMessage(message: unknown): Promise<any>;
    function sendMessage(tabId: number | undefined, message: unknown): Promise<any>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      active?: boolean;
      url?: string;
    }
    function query(queryInfo: Record<string, unknown>): Promise<Tab[]>;
    function sendMessage(tabId: number | undefined, message: unknown): Promise<any>;
    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
  }

  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }

  namespace commands {
    const onCommand: { addListener(callback: (command: string) => void): void };
  }
}

interface Window {
  __dalCorsPatched?: boolean;
}

interface HTMLVideoElement {
  requestVideoFrameCallback?(callback: (now: number, metadata?: unknown) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
  __dalCorsPatched?: boolean;
}

interface Element {
  checkVisibility?(options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }): boolean;
}

interface Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
}
