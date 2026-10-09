// "today", "yesterday", "3 days ago", "2 months ago": when something last changed, the way people say it. Counted
// in calendar days (local midnight to midnight), so last night at 23:00 is "yesterday" at 00:30.
export function timeAgo(iso: string, now = new Date()) {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(new Date(iso))) / 86_400_000)
  if (days < 1) return 'today'
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (days < 30) return format.format(-days, 'day')
  if (days < 365) return format.format(-Math.floor(days / 30), 'month')
  return format.format(-Math.floor(days / 365), 'year')
}
