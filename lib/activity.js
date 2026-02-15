(function attachWhyTabActivity(globalScope) {
  const ACTIVITY_LOG_KEY = 'activityLog';
  const MONTHLY_SUMMARIES_KEY = 'monthlySummaries';
  const RETENTION_DAYS = 90;

  function monthKeyFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  function getCurrentMonthKey(now = Date.now()) {
    return monthKeyFromTimestamp(now);
  }

  function aggregateMonthlySummary(month, events) {
    const openedByUrl = new Map();
    const queryCounts = new Map();

    let tabsSaved = 0;
    let tabsOpened = 0;
    let collectionsCreated = 0;
    let collectionsArchived = 0;
    let pruneSessions = 0;
    let totalPruneMinutes = 0;

    for (const event of events) {
      const metadata = event.metadata || {};
      switch (event.type) {
        case 'tabs_saved':
          tabsSaved += Number(metadata.count) || 0;
          break;
        case 'tab_opened': {
          tabsOpened += 1;
          const key = metadata.tabUrl || metadata.tabId || 'unknown';
          const existing = openedByUrl.get(key) || {
            title: metadata.tabTitle || metadata.tabUrl || 'Untitled tab',
            url: metadata.tabUrl || '',
            opens: 0,
          };
          existing.opens += 1;
          if (!existing.title && metadata.tabTitle) existing.title = metadata.tabTitle;
          if (!existing.url && metadata.tabUrl) existing.url = metadata.tabUrl;
          openedByUrl.set(key, existing);
          break;
        }
        case 'collection_created':
          collectionsCreated += 1;
          break;
        case 'collection_archived':
          collectionsArchived += 1;
          break;
        case 'prune_session':
          pruneSessions += 1;
          totalPruneMinutes += (Number(metadata.duration) || 0) / 60;
          break;
        case 'search_performed': {
          const query = String(metadata.query || '').trim();
          if (!query) break;
          queryCounts.set(query, (queryCounts.get(query) || 0) + 1);
          break;
        }
        default:
          break;
      }
    }

    const topTabs = [...openedByUrl.values()]
      .sort((a, b) => b.opens - a.opens)
      .slice(0, 5)
      .map((item) => ({ title: item.title, url: item.url, opens: item.opens }));

    const topSearches = [...queryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([query]) => query);

    return {
      month,
      tabsSaved,
      tabsOpened,
      collectionsCreated,
      collectionsArchived,
      pruneSessions,
      totalPruneMinutes: Math.round(totalPruneMinutes),
      topTabs,
      topSearches,
    };
  }

  async function logActivity(type, metadata = {}) {
    try {
      const { [ACTIVITY_LOG_KEY]: activityLog } = await chrome.storage.local.get(ACTIVITY_LOG_KEY);
      const log = Array.isArray(activityLog) ? activityLog : [];
      log.push({
        type,
        timestamp: Date.now(),
        metadata,
      });
      await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: log });
    } catch (_err) {
      // Intentionally silent so logging never impacts core UX.
    }
  }

  async function maintainActivityLog() {
    try {
      const now = Date.now();
      const cutoff = now - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const currentMonth = getCurrentMonthKey(now);

      const stored = await chrome.storage.local.get([ACTIVITY_LOG_KEY, MONTHLY_SUMMARIES_KEY]);
      const log = Array.isArray(stored[ACTIVITY_LOG_KEY]) ? stored[ACTIVITY_LOG_KEY] : [];
      const summaries = Array.isArray(stored[MONTHLY_SUMMARIES_KEY]) ? stored[MONTHLY_SUMMARIES_KEY] : [];

      const summaryByMonth = new Map(summaries.map((summary) => [summary.month, summary]));
      const eventsByMonth = new Map();

      for (const event of log) {
        if (!event || typeof event.timestamp !== 'number') continue;
        const month = monthKeyFromTimestamp(event.timestamp);
        if (month === currentMonth) continue;
        const bucket = eventsByMonth.get(month) || [];
        bucket.push(event);
        eventsByMonth.set(month, bucket);
      }

      let summariesChanged = false;
      for (const [month, events] of eventsByMonth.entries()) {
        if (summaryByMonth.has(month)) continue;
        summaryByMonth.set(month, aggregateMonthlySummary(month, events));
        summariesChanged = true;
      }

      const prunedLog = log.filter((event) => Number(event?.timestamp) >= cutoff);
      const logChanged = prunedLog.length !== log.length;

      if (summariesChanged || logChanged) {
        const orderedSummaries = [...summaryByMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
        const payload = {};
        if (summariesChanged) payload[MONTHLY_SUMMARIES_KEY] = orderedSummaries;
        if (logChanged) payload[ACTIVITY_LOG_KEY] = prunedLog;
        await chrome.storage.local.set(payload);
      }
    } catch (_err) {
      // Intentionally silent so maintenance never impacts core UX.
    }
  }

  globalScope.WhyTabActivity = {
    logActivity,
    maintainActivityLog,
  };
})(globalThis);
