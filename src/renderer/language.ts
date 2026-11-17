import { createContext, useContext, useEffect } from 'react'
import { DEFAULT_LANGUAGE, translator, type Language } from '../shared/language'

export const LanguageContext = createContext(DEFAULT_LANGUAGE)

export function useTranslation() {
  const language = useContext(LanguageContext)
  return { language, t: translator(language) }
}

export function useDocumentLanguage(language: Language) {
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
}
