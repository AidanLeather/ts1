/**
 * Storage abstraction for TabStash.
 *
 * Data shape in chrome.storage.local:
 * {
 *   collections: [ ... ],          // see below
 *   urlIndex: { [url]: count },    // fast duplicate lookup
 *   settings: { ... }
 * }
 *
 * Collection shape:
 * {
 *   id: string,
 *   name: string,
 *   createdAt: number,
 *   tabs: [
 *     {
 *       id: string,
 *       url: string,
 *       title: string,
 *       favIconUrl: string,
 *       savedAt: number,
 *       archived: boolean
 *     }
 *   ]
 * }
 *
 * urlIndex: A denormalized { url → count } object kept in sync whenever
 * tabs are added/removed. This gives O(1) duplicate lookups instead of
 * scanning every tab. We rebuild it from scratch if it ever gets out of
 * sync (e.g. after import or version upgrade).
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
  closeAfterSave: 'ask',   // 'always' | 'never' | 'ask'
  showDuplicateWarnings: true,
};

const Storage = {
  // ── Core getters ───────────────────────────────────────

  async getAll() {
    const data = await chrome.storage.local.get(['collections', 'urlIndex', 'settings']);
    return {
      collections: data.collections || [],
      urlIndex: data.urlIndex || {},
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

  // ── URL Index ──────────────────────────────────────────
  // The URL index is a plain object { url: count } stored alongside
  // collections. It counts non-archived tab instances per URL across
  // all collections, giving us O(1) duplicate detection even with
  // thousands of tabs.

  async getUrlIndex() {
    const { urlIndex } = await chrome.storage.local.get('urlIndex');
    return urlIndex || {};
  },

  async saveUrlIndex(urlIndex) {
    await chrome.storage.local.set({ urlIndex });
  },

  /**
   * Rebuild the URL index from scratch by scanning all collections.
   * Call this after imports, clears, or if the index seems stale.
   */
  async rebuildUrlIndex() {
    const collections = await this.getCollections();
    const idx = {};
    for (const col of collections) {
      for (const tab of col.tabs) {
        if (!tab.archived) {
          idx[tab.url] = (idx[tab.url] || 0) + 1;
        }
      }
    }
    await this.saveUrlIndex(idx);
    return idx;
  },

  // ── Collections CRUD ───────────────────────────────────

  /**
   * Add a new collection with the given tabs.
   * Updates the URL index atomically.
   */
  async addCollection(name, tabs) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

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

    // Update URL index
    for (const tab of collection.tabs) {
      urlIndex[tab.url] = (urlIndex[tab.url] || 0) + 1;
    }

    collections.unshift(collection);
    await chrome.storage.local.set({ collections, urlIndex });
    return collection;
  },

  /**
   * Ensure an "Unsorted" collection exists and return its id.
   */
  async ensureUnsorted() {
    const collections = await this.getCollections();
    let unsorted = collections.find((c) => c.name === 'Unsorted');
    if (!unsorted) {
      unsorted = {
        id: crypto.randomUUID(),
        name: 'Unsorted',
        createdAt: Date.now(),
        tabs: [],
      };
      collections.push(unsorted);
      await this.saveCollections(collections);
    }
    return unsorted.id;
  },

  /**
   * Count how many times a URL appears across all collections (non-archived).
   * Returns a Map<url, count> built from the URL index for compatibility
   * with existing popup code.
   */
  async getDuplicateCounts() {
    const urlIndex = await this.getUrlIndex();
    return new Map(Object.entries(urlIndex));
  },

  /**
   * Remove a tab by its id from any collection.
   */
  async removeTab(tabId) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    for (const col of collections) {
      const idx = col.tabs.findIndex((t) => t.id === tabId);
      if (idx !== -1) {
        const tab = col.tabs[idx];
        if (!tab.archived && urlIndex[tab.url]) {
          urlIndex[tab.url]--;
          if (urlIndex[tab.url] <= 0) delete urlIndex[tab.url];
        }
        col.tabs.splice(idx, 1);
        break;
      }
    }

    const filtered = collections.filter((c) => c.tabs.length > 0);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
  },

  /**
   * Move a tab to a different collection.
   */
  async moveTab(tabId, targetCollectionId) {
    const collections = await this.getCollections();
    let tab = null;

    for (const col of collections) {
      const idx = col.tabs.findIndex((t) => t.id === tabId);
      if (idx !== -1) {
        tab = col.tabs.splice(idx, 1)[0];
        break;
      }
    }

    if (!tab) return;

    const target = collections.find((c) => c.id === targetCollectionId);
    if (target) {
      target.tabs.push(tab);
    }

    const filtered = collections.filter((c) => c.tabs.length > 0);
    await this.saveCollections(filtered);
  },

  /**
   * Delete an entire collection.
   */
  async removeCollection(collectionId) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    const col = collections.find((c) => c.id === collectionId);
    if (col) {
      for (const tab of col.tabs) {
        if (!tab.archived && urlIndex[tab.url]) {
          urlIndex[tab.url]--;
          if (urlIndex[tab.url] <= 0) delete urlIndex[tab.url];
        }
      }
    }

    const filtered = collections.filter((c) => c.id !== collectionId);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
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

  // ── Duplicate merging ──────────────────────────────────

  /**
   * Merge all instances of a URL across all collections into a single
   * entry in the specified target collection (or the first occurrence's
   * collection). Keeps the earliest savedAt date.
   * Returns the number of duplicates removed.
   */
  async mergeDuplicates(url, targetCollectionId) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    // Gather all instances of this URL
    const instances = [];
    for (const col of collections) {
      for (let i = col.tabs.length - 1; i >= 0; i--) {
        if (col.tabs[i].url === url && !col.tabs[i].archived) {
          instances.push({ col, tab: col.tabs[i], idx: i });
        }
      }
    }

    if (instances.length <= 1) return 0;

    // Find earliest save date and best title (longest non-URL title)
    const earliestSavedAt = Math.min(...instances.map((i) => i.tab.savedAt));
    const bestTitle = instances
      .map((i) => i.tab.title)
      .filter((t) => t !== url)
      .sort((a, b) => b.length - a.length)[0] || url;

    // Remove all instances
    for (const inst of instances) {
      const idx = inst.col.tabs.indexOf(inst.tab);
      if (idx !== -1) inst.col.tabs.splice(idx, 1);
    }

    // Create single merged entry in target collection
    const target = collections.find((c) => c.id === targetCollectionId)
      || instances[0].col;
    target.tabs.unshift({
      id: crypto.randomUUID(),
      url,
      title: bestTitle,
      favIconUrl: instances[0].tab.favIconUrl,
      savedAt: earliestSavedAt,
      archived: false,
    });

    // Update index
    urlIndex[url] = 1;

    const filtered = collections.filter((c) => c.tabs.length > 0);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
    return instances.length - 1;
  },

  /**
   * Merge ALL duplicate URLs at once. Each URL's instances collapse
   * into one entry in the collection of their first occurrence.
   * Returns total duplicates removed.
   */
  async mergeAllDuplicates() {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    // Build map of url → [{col, tab, idx}]
    const urlMap = {};
    for (const col of collections) {
      for (const tab of col.tabs) {
        if (!tab.archived) {
          if (!urlMap[tab.url]) urlMap[tab.url] = [];
          urlMap[tab.url].push({ col, tab });
        }
      }
    }

    let totalRemoved = 0;

    for (const [url, instances] of Object.entries(urlMap)) {
      if (instances.length <= 1) continue;

      const earliestSavedAt = Math.min(...instances.map((i) => i.tab.savedAt));
      const bestTitle = instances
        .map((i) => i.tab.title)
        .filter((t) => t !== url)
        .sort((a, b) => b.length - a.length)[0] || url;
      const favIcon = instances[0].tab.favIconUrl;
      const targetCol = instances[0].col;

      // Remove all instances
      for (const inst of instances) {
        const idx = inst.col.tabs.indexOf(inst.tab);
        if (idx !== -1) inst.col.tabs.splice(idx, 1);
      }

      // Add merged entry
      targetCol.tabs.unshift({
        id: crypto.randomUUID(),
        url,
        title: bestTitle,
        favIconUrl: favIcon,
        savedAt: earliestSavedAt,
        archived: false,
      });

      urlIndex[url] = 1;
      totalRemoved += instances.length - 1;
    }

    const filtered = collections.filter((c) => c.tabs.length > 0);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
    return totalRemoved;
  },

  // ── Export ─────────────────────────────────────────────

  /**
   * Export a single collection as markdown.
   */
  exportCollectionAsMarkdown(col) {
    const lines = [`# ${col.name}`, ''];
    const active = col.tabs.filter((t) => !t.archived);
    const archived = col.tabs.filter((t) => t.archived);

    for (const tab of active) {
      lines.push(`- [${tab.title}](${tab.url})`);
    }
    if (archived.length > 0) {
      lines.push('', '## Archived', '');
      for (const tab of archived) {
        lines.push(`- [${tab.title}](${tab.url})`);
      }
    }
    return lines.join('\n');
  },

  // ── Archive ────────────────────────────────────────────

  /**
   * Archive tabs older than the configured threshold.
   * Returns the number of tabs archived.
   */
  async archiveOldTabs() {
    const settings = await this.getSettings();
    if (!settings.archiveEnabled) return 0;

    const cutoff = Date.now() - settings.archiveDays * 24 * 60 * 60 * 1000;
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};
    let count = 0;

    for (const col of collections) {
      for (const tab of col.tabs) {
        if (!tab.archived && tab.savedAt < cutoff) {
          tab.archived = true;
          // Remove from URL index since archived tabs don't count as dupes
          if (urlIndex[tab.url]) {
            urlIndex[tab.url]--;
            if (urlIndex[tab.url] <= 0) delete urlIndex[tab.url];
          }
          count++;
        }
      }
    }

    if (count > 0) {
      await chrome.storage.local.set({ collections, urlIndex });
    }
    return count;
  },

  /**
   * Get the number of days until a tab is archived.
   * Returns null if archiving is disabled, or Infinity if tab is already archived.
   */
  daysUntilArchive(tab, settings) {
    if (!settings.archiveEnabled || tab.archived) return null;
    const ageMs = Date.now() - tab.savedAt;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const remaining = settings.archiveDays - ageDays;
    return Math.max(0, Math.ceil(remaining));
  },

  // ── Search ─────────────────────────────────────────────

  /**
   * Fuzzy search across all tab titles and URLs.
   * Splits query into tokens and requires all tokens to match
   * somewhere in title+url (order-independent). This gives better
   * results than simple substring for multi-word queries.
   */
  search(collections, query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const tokens = q.split(/\s+/).filter(Boolean);

    const results = [];
    for (const col of collections) {
      for (const tab of col.tabs) {
        const haystack = (tab.title + ' ' + tab.url).toLowerCase();
        const match = tokens.every((token) => haystack.includes(token));
        if (match) {
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

if (typeof globalThis !== 'undefined') {
  globalThis.TabStashStorage = Storage;
}
