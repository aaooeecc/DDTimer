import { countdown } from '../shared/time'
import { useTranslation } from './language'

export function Countdown({ remaining, className }: { remaining: number; className: string }) {
  const { t } = useTranslation()
  const { days, hours, minutes, seconds } = countdown(remaining)
  return <div className={className} data-long={days.length > 2 || undefined}
    aria-label={t('{days}天 {hours}时 {minutes}分 {seconds}秒', { days, hours, minutes, seconds })}>
    <span>{days}<small>{t('天')}</small></span>
    <span>{hours}:{minutes}:{seconds}</span>
  </div>
}
