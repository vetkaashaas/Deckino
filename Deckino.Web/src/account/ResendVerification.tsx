import { Button, Text } from '@mantine/core'
import { useState } from 'react'
import { sendJson } from '../api'

export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')

  async function resend() {
    setState('sending')
    try {
      await sendJson('POST', '/api/account/resend-verification', { email })
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  if (state === 'sent') return <Text size="sm">Sent. Check your inbox for the new link.</Text>
  return (
    <div>
      <Button variant="default" size="sm" onClick={resend} loading={state === 'sending'}>
        Resend verification link
      </Button>
      {state === 'failed' && (
        <Text size="sm" c="red.4" mt="xs" role="alert">
          The link wasn't sent. Wait a few minutes, then try again.
        </Text>
      )}
    </div>
  )
}
