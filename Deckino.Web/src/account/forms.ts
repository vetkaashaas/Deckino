import type { UseFormReturnType } from '@mantine/form'
import { useState } from 'react'
import { ApiError } from '../api'

// Runs a form's API call: server validation errors go next to their fields, anything else into `error`.
export function useApiSubmit<T extends Record<string, unknown>>(form: UseFormReturnType<T>) {
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = (action: (values: T) => Promise<void>) =>
    form.onSubmit(async (values) => {
      setError(null)
      setSubmitting(true)
      try {
        await action(values)
      } catch (e) {
        if (!(e instanceof ApiError)) {
          setError("Deckino didn't respond. Check your connection and try again.")
        } else {
          const { '': general, ...fields } = e.fieldErrors
          form.setErrors(fields)
          if (general || Object.keys(fields).length === 0) setError(general ?? e.message)
        }
      } finally {
        setSubmitting(false)
      }
    })

  return { submit, error, setError, submitting }
}

// The same rules the API applies, checked before sending.
export const rules = {
  email: (value: string) => (/^\S+@\S+\.\S+$/.test(value.trim()) ? null : 'Enter a valid email address'),
  username: (value: string) =>
    /^[A-Za-z0-9_-]{3,20}$/.test(value.trim()) ? null : 'Use 3 to 20 letters, digits, _ or -',
  password: (value: string) =>
    value.length < 8 ? 'Use at least 8 characters' : value.length > 128 ? 'Use at most 128 characters' : null,
  required: (value: string) => (value ? null : 'Required'),
}
