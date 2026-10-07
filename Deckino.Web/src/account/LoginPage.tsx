import { Alert, Anchor, Button, Group, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError, sendJson } from '../api'
import { useAuth, type Account } from './auth'
import { AuthPage } from './AuthPage'
import { rules, useApiSubmit } from './forms'
import { ResendVerification } from './ResendVerification'

// Only same-site paths, so a crafted ?returnTo= can't send someone to another site after logging in.
function safeReturnTo(value: string | null) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/account'
}

export default function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { setAccount } = useAuth()
  const [unverified, setUnverified] = useState<string>()
  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: { email: rules.email, password: rules.required },
  })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <AuthPage title="Log in">
      <form
        onSubmit={submit(async (values) => {
          setUnverified(undefined)
          try {
            setAccount(await sendJson<Account>('POST', '/api/account/login', values))
            navigate(safeReturnTo(params.get('returnTo')), { replace: true })
          } catch (e) {
            if (e instanceof ApiError && e.status === 403) setUnverified(values.email.trim())
            else throw e
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
          {unverified && (
            <Alert color="purple" title="Verify your email first" role="alert">
              <Stack gap="sm">
                <Text size="sm">Open the link we sent to {unverified}, then log in.</Text>
                <ResendVerification email={unverified} />
              </Stack>
            </Alert>
          )}
          <TextInput label="Email" type="email" autoComplete="email" {...form.getInputProps('email')} />
          <PasswordInput label="Password" autoComplete="current-password" {...form.getInputProps('password')} />
          <Group justify="flex-end" mt={-8}>
            <Anchor component={Link} to="/forgot-password" size="sm">
              Forgot your password?
            </Anchor>
          </Group>
          <Button type="submit" variant="gradient" loading={submitting} fullWidth>
            Log in
          </Button>
          <Text size="sm" c="dimmed">
            New to Deckino?{' '}
            <Anchor component={Link} to="/register">
              Create an account
            </Anchor>
          </Text>
        </Stack>
      </form>
    </AuthPage>
  )
}
