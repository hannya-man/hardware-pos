// theme.js — dark (the default) or light, chosen per device from the menu.
// style.css keys its colours off data-theme on <html>; this sets it before
// anything is drawn and keeps the browser's own bar (Android's address bar,
// the installed app's title bar) the same colour as the page.

const KEY = 'rrc-theme';
const BAR = { dark: '#18191C', light: '#F5F4F2' };

function saved() {
  try {
    return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark'; // storage blocked (a private window): the default
  }
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[theme]);
}

apply(saved());

export const isDark = () => document.documentElement.dataset.theme !== 'light';

export function toggleTheme() {
  const theme = isDark() ? 'light' : 'dark';
  apply(theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch { /* it lasts until the app is closed */ }
  return theme;
}
