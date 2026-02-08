/**
 * Storage abstraction for TabStash.
 *
 * Data shape in chrome.storage.local:
 * {
 *   collections: [ ... ],          // see below
 *   urlIndex: { [url]: count },    // fast duplicate lookup
 *   settings: { ... },
 *   actionLog: [ { type, timestamp, tabId?, collectionId?, metadata? } ]
 * }
 *
 * Collection shape:
 * {
 *   id: string,
 *   name: string,
 *   createdAt: number,
 *   isPinned: boolean,
 *   notes: string,
 *   tabs: [
 *     {
 *       id: string,
 *       url: string,
 *       title: string,
 *       favIconUrl: string,
 *       savedAt: number,
 *       archived: boolean,
 *       tags: string[]
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
  closeAfterSave: 'always',   // 'always' | 'never' | 'ask'
  showDuplicateWarnings: true,
  closeTabsOnSave: true,      // close browser tabs after saving
};

const Storage = {
  // ── Core getters ───────────────────────────────────────

  async getAll() {
    const data = await chrome.storage.local.get(['collections', 'urlIndex', 'settings', 'actionLog']);
    return {
      collections: data.collections || [],
      urlIndex: data.urlIndex || {},
      settings: { ...DEFAULT_SETTINGS, ...data.settings },
      actionLog: data.actionLog || [],
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

  // ── Action Log ──────────────────────────────────────────

  async logAction(type, details = {}) {
    const { actionLog } = await chrome.storage.local.get('actionLog');
    const log = actionLog || [];
    log.push({
      type,
      timestamp: Date.now(),
      ...details,
    });
    // Cap at 10k entries to avoid storage bloat
    if (log.length > 10000) log.splice(0, log.length - 10000);
    await chrome.storage.local.set({ actionLog: log });
  },

  async getActionLog() {
    const { actionLog } = await chrome.storage.local.get('actionLog');
    return actionLog || [];
  },

  // ── URL Index ──────────────────────────────────────────

  async getUrlIndex() {
    const { urlIndex } = await chrome.storage.local.get('urlIndex');
    return urlIndex || {};
  },

  async saveUrlIndex(urlIndex) {
    await chrome.storage.local.set({ urlIndex });
  },

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

  async addCollection(name, tabs, options = {}) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    const collection = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      isPinned: options.isPinned || false,
      notes: options.notes || '',
      tabs: tabs.map((t) => ({
        id: crypto.randomUUID(),
        url: t.url,
        title: t.title || t.url,
        favIconUrl: t.favIconUrl || '',
        savedAt: Date.now(),
        archived: false,
        tags: t.tags || [],
      })),
    };

    // Update URL index
    for (const tab of collection.tabs) {
      urlIndex[tab.url] = (urlIndex[tab.url] || 0) + 1;
    }

    collections.unshift(collection);
    await chrome.storage.local.set({ collections, urlIndex });

    await this.logAction('save', {
      collectionId: collection.id,
      tabCount: collection.tabs.length,
    });

    return collection;
  },

  async ensureUnsorted() {
    const collections = await this.getCollections();
    let unsorted = collections.find((c) => c.name === 'Unsorted');
    if (!unsorted) {
      unsorted = {
        id: crypto.randomUUID(),
        name: 'Unsorted',
        createdAt: Date.now(),
        isPinned: false,
        notes: '',
        tabs: [],
      };
      collections.push(unsorted);
      await this.saveCollections(collections);
    }
    return unsorted.id;
  },

  async getDuplicateCounts() {
    const urlIndex = await this.getUrlIndex();
    return new Map(Object.entries(urlIndex));
  },

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
        await this.logAction('delete', { tabId, collectionId: col.id });
        break;
      }
    }

    const filtered = collections.filter((c) => c.tabs.length > 0 || c.isPinned);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
  },

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

    const filtered = collections.filter((c) => c.tabs.length > 0 || c.isPinned);
    await this.saveCollections(filtered);
  },

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
      await this.logAction('delete', { collectionId });
    }

    const filtered = collections.filter((c) => c.id !== collectionId);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
  },

  async renameCollection(collectionId, newName) {
    const collections = await this.getCollections();
    const col = collections.find((c) => c.id === collectionId);
    if (col) {
      col.name = newName;
      await this.saveCollections(collections);
    }
  },

  // ── Pin / Unpin ────────────────────────────────────────

  async togglePin(collectionId) {
    const collections = await this.getCollections();
    const col = collections.find((c) => c.id === collectionId);
    if (col) {
      col.isPinned = !col.isPinned;
      await this.saveCollections(collections);
      return col.isPinned;
    }
    return false;
  },

  // ── Notes ──────────────────────────────────────────────

  async updateNotes(collectionId, notes) {
    const collections = await this.getCollections();
    const col = collections.find((c) => c.id === collectionId);
    if (col) {
      col.notes = notes;
      await this.saveCollections(collections);
    }
  },

  // ── Tags ───────────────────────────────────────────────

  async addTag(tabId, tag) {
    const collections = await this.getCollections();
    for (const col of collections) {
      const tab = col.tabs.find((t) => t.id === tabId);
      if (tab) {
        if (!tab.tags) tab.tags = [];
        const normalized = tag.trim().toLowerCase();
        if (normalized && !tab.tags.includes(normalized)) {
          tab.tags.push(normalized);
          await this.saveCollections(collections);
          await this.logAction('tag', { tabId, tag: normalized });
        }
        return tab.tags;
      }
    }
    return [];
  },

  async removeTag(tabId, tag) {
    const collections = await this.getCollections();
    for (const col of collections) {
      const tab = col.tabs.find((t) => t.id === tabId);
      if (tab) {
        if (!tab.tags) tab.tags = [];
        tab.tags = tab.tags.filter((t) => t !== tag);
        await this.saveCollections(collections);
        return tab.tags;
      }
    }
    return [];
  },

  // ── Duplicate merging ──────────────────────────────────

  async mergeDuplicates(url, targetCollectionId) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    const instances = [];
    for (const col of collections) {
      for (let i = col.tabs.length - 1; i >= 0; i--) {
        if (col.tabs[i].url === url && !col.tabs[i].archived) {
          instances.push({ col, tab: col.tabs[i], idx: i });
        }
      }
    }

    if (instances.length <= 1) return 0;

    const earliestSavedAt = Math.min(...instances.map((i) => i.tab.savedAt));
    const bestTitle = instances
      .map((i) => i.tab.title)
      .filter((t) => t !== url)
      .sort((a, b) => b.length - a.length)[0] || url;

    const allTags = [...new Set(instances.flatMap((i) => i.tab.tags || []))];

    for (const inst of instances) {
      const idx = inst.col.tabs.indexOf(inst.tab);
      if (idx !== -1) inst.col.tabs.splice(idx, 1);
    }

    const target = collections.find((c) => c.id === targetCollectionId)
      || instances[0].col;
    target.tabs.unshift({
      id: crypto.randomUUID(),
      url,
      title: bestTitle,
      favIconUrl: instances[0].tab.favIconUrl,
      savedAt: earliestSavedAt,
      archived: false,
      tags: allTags,
    });

    urlIndex[url] = 1;

    const filtered = collections.filter((c) => c.tabs.length > 0 || c.isPinned);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
    return instances.length - 1;
  },

  async mergeAllDuplicates() {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

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
      const allTags = [...new Set(instances.flatMap((i) => i.tab.tags || []))];

      for (const inst of instances) {
        const idx = inst.col.tabs.indexOf(inst.tab);
        if (idx !== -1) inst.col.tabs.splice(idx, 1);
      }

      targetCol.tabs.unshift({
        id: crypto.randomUUID(),
        url,
        title: bestTitle,
        favIconUrl: favIcon,
        savedAt: earliestSavedAt,
        archived: false,
        tags: allTags,
      });

      urlIndex[url] = 1;
      totalRemoved += instances.length - 1;
    }

    const filtered = collections.filter((c) => c.tabs.length > 0 || c.isPinned);
    await chrome.storage.local.set({ collections: filtered, urlIndex });
    return totalRemoved;
  },

  // ── Export ─────────────────────────────────────────────

  exportCollectionAsMarkdown(col) {
    const lines = [`# ${col.name}`, ''];
    if (col.notes) {
      lines.push(col.notes, '');
    }
    const active = col.tabs.filter((t) => !t.archived);
    const archived = col.tabs.filter((t) => t.archived);

    for (const tab of active) {
      const tagStr = tab.tags?.length ? ` \`${tab.tags.join('` `')}\`` : '';
      lines.push(`- [${tab.title}](${tab.url})${tagStr}`);
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

  async archiveOldTabs() {
    const settings = await this.getSettings();
    if (!settings.archiveEnabled) return 0;

    const cutoff = Date.now() - settings.archiveDays * 24 * 60 * 60 * 1000;
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};
    let count = 0;

    for (const col of collections) {
      if (col.isPinned) continue; // pinned collections are protected from auto-archive
      for (const tab of col.tabs) {
        if (!tab.archived && tab.savedAt < cutoff) {
          tab.archived = true;
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

  daysUntilArchive(tab, settings) {
    if (!settings.archiveEnabled || tab.archived) return null;
    const ageMs = Date.now() - tab.savedAt;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const remaining = settings.archiveDays - ageDays;
    return Math.max(0, Math.ceil(remaining));
  },

  // ── Search ─────────────────────────────────────────────

  search(collections, query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const tokens = q.split(/\s+/).filter(Boolean);

    const results = [];
    for (const col of collections) {
      for (const tab of col.tabs) {
        const tagStr = (tab.tags || []).join(' ');
        const haystack = (tab.title + ' ' + tab.url + ' ' + tagStr).toLowerCase();
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

  // ── Manual tab ──────────────────────────────────────────

  async addManualTab(collectionId, title, url) {
    const data = await chrome.storage.local.get(['collections', 'urlIndex']);
    const collections = data.collections || [];
    const urlIndex = data.urlIndex || {};

    const col = collections.find((c) => c.id === collectionId);
    if (!col) return null;

    const tab = {
      id: crypto.randomUUID(),
      url,
      title: title || url,
      favIconUrl: '',
      savedAt: Date.now(),
      archived: false,
      tags: [],
    };

    col.tabs.push(tab);
    urlIndex[url] = (urlIndex[url] || 0) + 1;

    await chrome.storage.local.set({ collections, urlIndex });
    await this.logAction('save', { collectionId, tabId: tab.id });
    return tab;
  },

  // ── Sorting helper ────────────────────────────────────

  sortCollections(collections) {
    return [...collections].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return 0;
    });
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.TabStashStorage = Storage;
}
