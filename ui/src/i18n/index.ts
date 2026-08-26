import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

const UI_LANGUAGE_STORAGE_KEY = "paperclip.ui.language";

function readStoredUiLanguage(): string | null {
  try {
    const value = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    return typeof value === "string" && supportedLocales.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function persistUiLanguage(locale: string) {
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for the
    // session only, which is still better than refusing to switch.
  }
}

const initialLanguage = readStoredUiLanguage() ?? DEFAULT_LOCALE;

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: initialLanguage,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  // Natural keys: UI strings are keyed by their English source text, so the
  // English bundle is flat and untranslated keys degrade gracefully to the
  // source text instead of a raw dotted path.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/**
 * Switch the UI language and remember the choice across reloads. Safe to call
 * with any supported locale; unknown locales fall back to English via i18next.
 */
export function setUiLanguage(locale: string) {
  persistUiLanguage(locale);
  void i18n.changeLanguage(locale);
}

export function currentUiLanguage() {
  return i18n.language ?? DEFAULT_LOCALE;
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
