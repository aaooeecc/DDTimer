import { useEffect, useState } from 'react'
import { PRODUCT_NAME, type MiniCountdown } from '../shared/domain'
import { DEFAULT_LANGUAGE, translator } from '../shared/language'
import { Countdown } from './Countdown'
import { useClock } from './clock'
import { LanguageContext, useDocumentLanguage } from './language'
import styles from './Mini.module.css'

export function Mini() {
  const [model, setModel] = useState<MiniCountdown | null>(null)
  const now = useClock(model?.fixedNow ?? null)
  const language = model?.language ?? DEFAULT_LANGUAGE
  const t = translator(language)
  const title = `${PRODUCT_NAME} · ${t('迷你悬浮窗')}`
  useDocumentLanguage(language)
  useEffect(() => { document.title = title }, [title])

  useEffect(() => {
    let canApplyInitial = true
    const stop = window.tsTimer.onMiniCountdown(next => {
      canApplyInitial = false
      setModel(next)
    })
    void window.tsTimer['mini:getCountdown'](undefined).then(result => {
      if (canApplyInitial && result.ok) setModel(result.data)
    }).catch(() => undefined)
    return () => { canApplyInitial = false; stop() }
  }, [])

  if (!model) return null
  return <LanguageContext value={language}>
    <main className={styles.card}>
      <h1>{t('距最终截止')}</h1>
      <Countdown remaining={Math.max(0, model.deadlineAtMs - now)} className={styles.countdown} />
    </main>
  </LanguageContext>
}
