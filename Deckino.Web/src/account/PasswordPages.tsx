import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError, sendJson } from '../api'
import { AuthPage } from './AuthPage'
import { rules, useApiSubmit } from './forms'

// The answer is the same whether or not the email has an account.
export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string>()
  const form = useForm({ initialValues: { email: '' }, validate: { email: rules.email } })
  const { submit, error, submitting } = useApiSubmit(form)

  if (sentTo) {
    return (
      <AuthPage title="Check your email">
        <Text>
          If an account uses <strong>{sentTo}</strong>, we've sent it a link to choose a new password.
        </Text>
      </AuthPage>
    )
  }
  return (
    <AuthPage title="Reset your password" intro="Enter your account's email and we'll send you a reset link.">
      <form
        onSubmit={submit(async (values) => {
          await sendJson('POST', '/api/account/forgot-password', values)
          setSentTo(values.email.trim())
        })}
        noValidate
      >
        <Stack gap="md">
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <TextInput label="Email" type="email" autoComplete="email" {...form.getInputProps('email')} />
          <Button type="submit" variant="gradient" loading={submitting} fullWidth>
            Send reset link
          </Button>
        </Stack>
      </form>
    </AuthPage>
  )
}

// Opened from the emailed link (/reset-password?userId=…&token=…).
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const [state, setState] = useState<'form' | 'done' | 'badLink'>('form')
  const form = useForm({ initialValues: { password: '' }, validate: { password: rules.password } })
  const { submit, error, submitting } = useApiSubmit(form)

  if (state === 'done') {
    return (
      <AuthPage title="Password changed">
        <Stack gap="md" align="flex-start">
          <Text>Log in with your new password.</Text>
          <Button component={Link} to="/login" variant="gradient">
            Log in
          </Button>
        </Stack>
      </AuthPage>
    )
  }
  if (state === 'badLink') {
    return (
      <AuthPage title="This link didn't work">
        <Alert color="red" role="alert">
          The reset link is invalid or has expired.{' '}
          <Anchor component={Link} to="/forgot-password">
            Request a new one
          </Anchor>
          .
        </Alert>
      </AuthPage>
    )
  }
  return (
    <AuthPage title="Choose a new password">
      <form
        onSubmit={submit(async (values) => {
          try {
            await sendJson('POST', '/api/account/reset-password', {
              userId: params.get('userId'),
              token: params.get('token'),
              password: values.password,
            })
            setState('done')
          } catch (e) {
            if (e instanceof ApiError && e.status === 400 && Object.keys(e.fieldErrors).length === 0) {
              setState('badLink')
            } else throw e
          }
        })}
        noValidate
      >
        <Stack gap="md">
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <PasswordInput
            label="New password"
            description="At least 8 characters."
            autoComplete="new-password"
            {...form.getInputProps('password')}
          />
          <Button type="submit" variant="gradient" loading={submitting} fullWidth>
            Save password
          </Button>
        </Stack>
      </form>
    </AuthPage>
  )
}
