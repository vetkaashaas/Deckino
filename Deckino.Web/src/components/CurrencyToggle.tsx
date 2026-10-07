import { SegmentedControl } from '@mantine/core'
import type { Currency } from './currency'

export function CurrencyToggle({ currency, onChange }: { currency: Currency; onChange: (c: Currency) => void }) {
  return (
    <SegmentedControl
      aria-label="Currency"
      size="xs"
      value={currency}
      onChange={(value) => onChange(value as Currency)}
      data={[
        { label: 'USD', value: 'usd' },
        { label: 'EUR', value: 'eur' },
      ]}
    />
  )
}
