import { Alert, Button, Loader, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { sendJson } from '../api'
import { AuthPage } from './AuthPage'
import { ResendVerification } from './ResendVerification'

// Opened from the emailed link (/verify-email?userId=…&token=…). Verifying twice is harmless.
export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const [state, setState] = useState<'verifying' | 'verified' | 'failed'>('verifying')
  const [email, setEmail] = useState('')

  useEffect(() => {
    sendJson('POST', '/api/account/verify-email', { userId: params.get('userId'), token: params.get('token') })
      .then(() => setState('verified'))
      .catch(() => setState('failed'))
  }, [params])

  if (state === 'verifying') {
    return (
      <AuthPage title="Verifying your email">
        <Loader size="sm" aria-label="Verifying" />
      </AuthPage>
    )
  }
  if (state === 'verified') {
    return (
      <AuthPage title="Email verified">
        <Stack gap="md" align="flex-start">
          <Text>Your account is ready.</Text>
          <Button component={Link} to="/login" variant="gradient">
            Log in
          </Button>
        </Stack>
      </AuthPage>
    )
  }
  return (
    <AuthPage title="This link didn't work">
      <Stack gap="md">
        <Alert color="red" role="alert">
          The verification link is invalid or has expired. Enter your email to get a new one.
        </Alert>
        <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        {email.trim() && <ResendVerification email={email.trim()} />}
      </Stack>
    </AuthPage>
  )
}
