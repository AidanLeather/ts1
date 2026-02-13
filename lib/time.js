const WhyTabTime = {
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
};

if (typeof globalThis !== 'undefined') {
  globalThis.WhyTabTime = WhyTabTime;
}
