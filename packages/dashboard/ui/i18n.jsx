import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  createTranslator,
  detectLanguage,
  formatDate,
  saveLanguage,
  errorText,
} from './i18n-core.js';
const Context = createContext(null);
function storage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
/** Share one presentation language without remounting data panels. */
export function I18nProvider({ children }) {
  const [language, updateLanguage] = useState(() =>
    detectLanguage(storage(), navigator.languages, navigator.language),
  );
  const value = useMemo(() => {
    const t = createTranslator(language);
    return {
      language,
      t,
      setLanguage: (next) => {
        saveLanguage(storage(), next);
        updateLanguage(next);
      },
      formatDate: (date) => formatDate(date, language),
      errorText: (error) => errorText(error, t),
    };
  }, [language]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = value.t('main.title');
  }, [language, value]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
/** Read the shared language and presentation helpers. */
export function useI18n() {
  return useContext(Context);
}
