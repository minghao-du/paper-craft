import main from './locales/main.js';
import history from './locales/history.js';

export const dictionaries = { en: { ...main.en, ...history.en }, 'zh-CN': { ...main['zh-CN'], ...history['zh-CN'] } };
/** Select a supported language without persisting automatic detection. */
export function detectLanguage(storage, languages, language) {
  try {
    const saved = storage?.getItem('paper-craft-language');
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch {
    /* Restricted storage. */
  }
  for (const candidate of languages ?? [language]) {
    if (/^zh(?:-|$)/i.test(candidate || '')) return 'zh-CN';
    if (/^en(?:-|$)/i.test(candidate || '')) return 'en';
  }
  return 'en';
}
/** Persist an explicit preference, tolerating restricted storage. */
export function saveLanguage(storage, language) {
  try {
    storage?.setItem('paper-craft-language', language);
  } catch {
    /* The page still switches. */
  }
}
/** Translate a complete sentence using named parameters. */
export function createTranslator(language, catalog = dictionaries) {
  return (key, params = {}) =>
    (catalog[language]?.[key] ?? catalog.en[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    );
}
/** Format presentation dates, preserving invalid evidence. */
export function formatDate(value, language, timeZone) {
  if (!value || !Number.isFinite(Date.parse(value))) return value;
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}
/** Create a frontend-owned error independently of the backend protocol. */
export function readFailure(status) {
  const error = new Error(`Read failed (${status}). Open the startup link to authenticate.`);
  error.translationKey = 'common.readFailed';
  error.params = { status };
  return error;
}
/** Translate only frontend-owned errors; preserve exception/backend text. */
export function errorText(error, t) {
  return error?.translationKey ? t(error.translationKey, error.params) : (error?.message ?? error);
}
