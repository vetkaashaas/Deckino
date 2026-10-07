import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useState } from 'react'
import { Link } from 'react-router'
import { sendJson } from '../api'
import { AuthPage } from './AuthPage'
import { rules, useApiSubmit } from './forms'
import { ResendVerification } from './ResendVerification'

export default function RegisterPage() {
  const [sentTo, setSentTo] = useState<string>()
  const form = useForm({
    initialValues: { email: '', username: '', password: '' },
    validate: { email: rules.email, username: rules.username, password: rules.password },
  })
  const { submit, error, submitting } = useApiSubmit(form)

  if (sentTo) {
    return (
      <AuthPage title="Check your email">
        <Stack gap="md">
          <Text>
            We sent a verification link to <strong>{sentTo}</strong>. Open it to finish creating your account.
          </Text>
          <ResendVerification email={sentTo} />
        </Stack>
      </AuthPage>
    )
  }

  return (
    <AuthPage title="Create your account" intro="Build decks, track your binders and share them.">
      <form
        onSubmit={submit(async (values) => {
          await sendJson('POST', '/api/account/register', values)
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
          <TextInput
            label="Username"
            description="Shown on decks and binders you share. 3 to 20 letters, digits, _ or -."
            autoComplete="username"
            {...form.getInputProps('username')}
          />
          <PasswordInput
            label="Password"
            description="At least 8 characters."
            autoComplete="new-password"
            {...form.getInputProps('password')}
          />
          <Button type="submit" variant="gradient" loading={submitting} fullWidth>
            Create account
          </Button>
          <Text size="sm" c="dimmed">
            Already have an account?{' '}
            <Anchor component={Link} to="/login">
              Log in
            </Anchor>
          </Text>
        </Stack>
      </form>
    </AuthPage>
  )
}
