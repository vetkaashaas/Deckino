// Photos shared into the app arrive as an expo-sharing deep link; scan them on their own page.
// deckino.com links (Android App Links, AppPlan A8) open the app's screen for the same page. The app's /deck/[id] and
// /binder/[id] are the owner's, so the website's public pages open the public screens. A regex, not URL: React
// Native's URL implements few of its getters.
const WEBSITE = /^https:\/\/deckino\.com(?=[/?#]|$)(\/[^?#]*)?(\?[^#]*)?/i; // the host ends there: not deckino.com.evil.com
const PAGE = /^\/(deck|binder|cards)\/([0-9a-f-]{36})\/?$/i;
const EMAIL = /^\/(verify-email|reset-password)\/?$/i;

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  const site = WEBSITE.exec(path);
  if (site) {
    const [, pathname = '/', search = ''] = site;
    const page = PAGE.exec(pathname);
    if (page) return page[1].toLowerCase() === 'cards' ? `/card/${page[2]}` : `/public/${page[1].toLowerCase()}/${page[2]}`;
    const email = EMAIL.exec(pathname);
    if (email) return `/${email[1].toLowerCase()}${search}`;
    return '/';
  }
  try {
    return new URL(path).hostname === 'expo-sharing' ? '/shared-scan' : path;
  } catch {
    return path;
  }
}
