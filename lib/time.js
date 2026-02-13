const WhyTabTime = {
  SESSION_TITLE_MAX_LENGTH: 50,

  timeOfDayLabel(date) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  },

  formatWeekdayTimeName(date = new Date()) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${weekdays[date.getDay()]} ${this.timeOfDayLabel(date)}`;
  },

  formatSessionTimestamp(date = new Date()) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()} ${this.timeOfDayLabel(date)}`;
  },

  formatSessionTimestampWithTime(date = new Date()) {
    const hour = date.getHours() % 12 || 12;
    const mins = String(date.getMinutes()).padStart(2, '0');
    const suffix = date.getHours() >= 12 ? 'pm' : 'am';
    return `${this.formatSessionTimestamp(date)} ${hour}:${mins}${suffix}`;
  },

  generateSessionCollectionTitle(tabs, date = new Date()) {
    const timestamp = this.formatSessionTimestamp(date);
    if (!Array.isArray(tabs) || tabs.length === 0) {
      return { name: timestamp, autoTitleType: 'timeOfDay', timestampOnly: true };
    }

    if (tabs.length === 1) {
      const tabTitle = tabs[0]?.title?.trim() || tabs[0]?.url || '';
      if (tabTitle) {
        return {
          name: tabTitle.length > this.SESSION_TITLE_MAX_LENGTH
            ? `${tabTitle.slice(0, this.SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`
            : tabTitle,
          autoTitleType: 'smart',
          timestampOnly: false,
        };
      }
    }

    const domainTitle = this._buildDomainTitle(tabs, timestamp);
    if (domainTitle) return { name: domainTitle, autoTitleType: 'smart', timestampOnly: false };

    const keywordTitle = this._buildKeywordTitle(tabs, timestamp);
    if (keywordTitle) return { name: keywordTitle, autoTitleType: 'smart', timestampOnly: false };

    return { name: timestamp, autoTitleType: 'timeOfDay', timestampOnly: true };
  },

  _buildDomainTitle(tabs, timestamp) {
    const counts = new Map();
    for (const tab of tabs) {
      const hostname = this._extractHostname(tab?.url);
      if (!hostname) continue;
      counts.set(hostname, (counts.get(hostname) || 0) + 1);
    }
    if (!counts.size) return '';

    const [topDomain, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const ratio = topCount / tabs.length;
    if (ratio < 0.4) return '';

    const domainLabel = this._formatDomainLabel(topDomain);
    return ratio >= 0.75
      ? `${domainLabel} — ${timestamp}`
      : `Mostly ${domainLabel} — ${timestamp}`;
  },

  _buildKeywordTitle(tabs, timestamp) {
    const stopWords = new Set([
      'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','it','this','that','are','was','were','be','been','has','have','had','do','does','did','will','would','could','should','can','may','not','no','so','if','as','into','than','its','our','my','your','how','what','when','where','who','which','why','all','each','new','about','up','out','just','more','also','get','one','two','like','make','over','such','after','before','between','through','during','only','other','some','them','then','these','those','very','most','own','same','both','few','any','many','us','home','page','site','app','web','online','free','best','top','official','welcome','log','sign','dashboard','untitled','contact','null','undefined'
    ]);
    const wordCounts = new Map();
    const titleCounts = new Map();

    for (const tab of tabs) {
      const title = tab?.title?.trim();
      if (!title) continue;

      const seen = new Set();
      const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      for (const word of words) {
        if (word.length <= 1) continue;
        if (/^\d+$/.test(word)) continue;
        if (stopWords.has(word)) continue;

        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        if (!seen.has(word)) {
          seen.add(word);
          titleCounts.set(word, (titleCounts.get(word) || 0) + 1);
        }
      }
    }

    const meaningful = [...wordCounts.entries()]
      .filter(([word]) => (titleCounts.get(word) || 0) >= 2)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });

    if (!meaningful.length) return '';

    const topWords = meaningful.slice(0, 2).map(([word]) => `${word[0].toUpperCase()}${word.slice(1)}`);
    return `${topWords.join(', ')} — ${timestamp}`;
  },

  _extractHostname(rawUrl) {
    if (!rawUrl || rawUrl.startsWith('chrome://') || rawUrl.startsWith('about:')) return '';
    try {
      return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  },

  _formatDomainLabel(hostname) {
    const domainLabels = {
      github: 'GitHub',
      gitlab: 'GitLab',
      dribbble: 'Dribbble',
      stackoverflow: 'Stack Overflow',
      youtube: 'YouTube',
      reddit: 'Reddit',
      figma: 'Figma',
      notion: 'Notion',
      linear: 'Linear',
    };

    const parts = hostname.split('.');
    if (parts.length === 2) {
      const key = parts[0];
      if (domainLabels[key]) return domainLabels[key];
    }
    return hostname;
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.WhyTabTime = WhyTabTime;
}
