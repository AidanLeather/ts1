/**
 * Storage abstraction for TabStash.
 *
 * Data shape in chrome.storage.local:
 * {
 *   collections: [
 *     {
 *       id: string,          // crypto.randomUUID()
 *       name: string,
 *       createdAt: number,   // Date.now()
 *       tabs: [
 *         {
 *           id: string,
 *           url: string,
 *           title: string,
 *           favIconUrl: string,
 *           savedAt: number,
 *           archived: boolean
 *         }
 *       ]
 *     }
 *   ],
 *   settings: {
 *     archiveEnabled: boolean,
 *     archiveDays: number
 *   }
 * }
 *
 * Why chrome.storage.local instead of localStorage?
 * - Available in service workers (localStorage isn't)
 * - Up to 10 MB vs 5 MB
 * - Async API that won't block the UI
 * - Accessible from popup, background, and options pages without message passing
 */

const DEFAULT_SETTINGS = {
  archiveEnabled: true,
  archiveDays: 30,
};

const Storage = {
  async getAll() {
    const data = await chrome.storage.local.get(['collections', 'settings']);
    return {
      collections: data.collections || [],
      settings: { ...DEFAULT_SETTINGS, ...data.settings },
    };
  },

  async getCollections() {
    const { collections } = await chrome.storage.local.get('collections');
    return collections || [];
  },

  async saveCollections(collections) {
    await chrome.storage.local.set({ collections });
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({ settings });
  },

  /**
   * Add a new collection with the given tabs.
   * Returns the created collection object.
   */
  async addCollection(name, tabs) {
    const collections = await this.getCollections();
    const collection = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      tabs: tabs.map((t) => ({
        id: crypto.randomUUID(),
        url: t.url,
        title: t.title || t.url,
        favIconUrl: t.favIconUrl || '',
        savedAt: Date.now(),
        archived: false,
      })),
    };
    collections.unshift(collection);
    await this.saveCollections(collections);
    return collection;
  },

  /**
   * Count how many times a URL appears across all collections (non-archived).
   * Returns a Map<url, count>.
   */
  async getDuplicateCounts() {
    const collections = await this.getCollections();
    const counts = new Map();
    for (const col of collections) {
      for (const tab of col.tabs) {
        if (!tab.archived) {
          const url = tab.url;
          counts.set(url, (counts.get(url) || 0) + 1);
        }
      }
    }
    return counts;
  },

  /**
   * Remove a tab by its id from any collection.
   */
  async removeTab(tabId) {
    const collections = await this.getCollections();
    for (const col of collections) {
      col.tabs = col.tabs.filter((t) => t.id !== tabId);
    }
    // Remove empty collections
    const filtered = collections.filter((c) => c.tabs.length > 0);
    await this.saveCollections(filtered);
  },

  /**
   * Move a tab to a different collection.
   */
  async moveTab(tabId, targetCollectionId) {
    const collections = await this.getCollections();
    let tab = null;

    // Find and remove from source
    for (const col of collections) {
      const idx = col.tabs.findIndex((t) => t.id === tabId);
      if (idx !== -1) {
        tab = col.tabs.splice(idx, 1)[0];
        break;
      }
    }

    if (!tab) return;

    // Add to target
    const target = collections.find((c) => c.id === targetCollectionId);
    if (target) {
      target.tabs.push(tab);
    }

    // Remove empty collections
    const filtered = collections.filter((c) => c.tabs.length > 0);
    await this.saveCollections(filtered);
  },

  /**
   * Delete an entire collection.
   */
  async removeCollection(collectionId) {
    const collections = await this.getCollections();
    const filtered = collections.filter((c) => c.id !== collectionId);
    await this.saveCollections(filtered);
  },

  /**
   * Rename a collection.
   */
  async renameCollection(collectionId, newName) {
    const collections = await this.getCollections();
    const col = collections.find((c) => c.id === collectionId);
    if (col) {
      col.name = newName;
      await this.saveCollections(collections);
    }
  },

  /**
   * Archive tabs older than the configured threshold.
   * Returns the number of tabs archived.
   */
  async archiveOldTabs() {
    const settings = await this.getSettings();
    if (!settings.archiveEnabled) return 0;

    const cutoff = Date.now() - settings.archiveDays * 24 * 60 * 60 * 1000;
    const collections = await this.getCollections();
    let count = 0;

    for (const col of collections) {
      for (const tab of col.tabs) {
        if (!tab.archived && tab.savedAt < cutoff) {
          tab.archived = true;
          count++;
        }
      }
    }

    if (count > 0) {
      await this.saveCollections(collections);
    }
    return count;
  },

  /**
   * Search across all tab titles and URLs.
   * Returns matching tabs with their collection info.
   */
  search(collections, query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const results = [];
    for (const col of collections) {
      for (const tab of col.tabs) {
        if (
          tab.title.toLowerCase().includes(q) ||
          tab.url.toLowerCase().includes(q)
        ) {
          results.push({
            ...tab,
            collectionId: col.id,
            collectionName: col.name,
          });
        }
      }
    }
    return results;
  },
};

// Make available to both modules and non-module scripts
if (typeof globalThis !== 'undefined') {
  globalThis.TabStashStorage = Storage;
}
