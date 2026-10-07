import { Alert, Button, Container, Group, Modal, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { sendJson } from '../api'
import { ArtHeader } from '../components/ArtHeader'
import { useAuth, type Account } from './auth'
import classes from './AccountPage.module.css'
import { rules, useApiSubmit } from './forms'

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className={classes.section} aria-label={title}>
      <div>
        <Title order={2} className={classes.sectionTitle}>
          {title}
        </Title>
        {description && (
          <Text c="dimmed" size="sm" mt={4}>
            {description}
          </Text>
        )}
      </div>
      <div>{children}</div>
    </section>
  )
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" c="green.4" role="status">
      {children}
    </Text>
  )
}

function UsernameForm({ account }: { account: Account }) {
  const { setAccount } = useAuth()
  const [saved, setSaved] = useState(false)
  const form = useForm({ initialValues: { username: account.username }, validate: { username: rules.username } })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <form
      onSubmit={submit(async (values) => {
        setSaved(false)
        setAccount(await sendJson<Account>('PUT', '/api/account/username', values))
        setSaved(true)
      })}
      noValidate
    >
      <Stack gap="sm" align="flex-start">
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <TextInput label="Username" autoComplete="username" w="100%" maw={360} {...form.getInputProps('username')} />
        <Group gap="md">
          <Button type="submit" variant="default" loading={submitting}>
            Save username
          </Button>
          {saved && <Saved>Username saved</Saved>}
        </Group>
      </Stack>
    </form>
  )
}

function PasswordForm() {
  const [saved, setSaved] = useState(false)
  const form = useForm({
    initialValues: { currentPassword: '', newPassword: '' },
    validate: { currentPassword: rules.required, newPassword: rules.password },
  })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <form
      onSubmit={submit(async (values) => {
        setSaved(false)
        await sendJson('PUT', '/api/account/password', values)
        form.reset()
        setSaved(true)
      })}
      noValidate
    >
      <Stack gap="sm" align="flex-start">
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          w="100%"
          maw={360}
          {...form.getInputProps('currentPassword')}
        />
        <PasswordInput
          label="New password"
          description="At least 8 characters."
          autoComplete="new-password"
          w="100%"
          maw={360}
          {...form.getInputProps('newPassword')}
        />
        <Group gap="md">
          <Button type="submit" variant="default" loading={submitting}>
            Change password
          </Button>
          {saved && <Saved>Password changed. Other devices are logged out.</Saved>}
        </Group>
      </Stack>
    </form>
  )
}

function DeleteAccount({ onLeave }: { onLeave: () => void }) {
  const { setAccount } = useAuth()
  const navigate = useNavigate()
  const [open, dialog] = useDisclosure()
  const form = useForm({ initialValues: { password: '' }, validate: { password: rules.required } })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <>
      <Button color="red" variant="light" onClick={dialog.open}>
        Delete account
      </Button>
      <Modal opened={open} onClose={dialog.close} title="Delete your account?" centered>
        <form
          onSubmit={submit(async (values) => {
            await sendJson('DELETE', '/api/account', values)
            onLeave()
            setAccount(null)
            navigate('/', { replace: true })
          })}
          noValidate
        >
          <Stack gap="md">
            <Text>
              This permanently deletes your account and everything in it: decks, binders and your wishlist. It can't
              be undone.
            </Text>
            {error && <Alert color="red" role="alert">{error}</Alert>}
            <PasswordInput
              label="Enter your password to confirm"
              autoComplete="current-password"
              data-autofocus
              {...form.getInputProps('password')}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.close}>
                Keep account
              </Button>
              <Button type="submit" color="red" loading={submitting}>
                Delete account
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  )
}

export default function AccountPage() {
  const { account, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  // Set when the user logs out or deletes the account here, so the signed-out state that follows
  // sends them home rather than to the login page.
  const [leaving, setLeaving] = useState(false)

  if (account === undefined || (account === null && leaving)) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  return (
    <>
      <ArtHeader>
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={1}>Your account</Title>
            <Text c="dimmed" mt="xs">
              Signed in as <strong>{account.username}</strong>
            </Text>
          </div>
          <Button
            variant="default"
            onClick={async () => {
              setLeaving(true)
              await logout()
              navigate('/', { replace: true })
            }}
          >
            Log out
          </Button>
        </Group>
      </ArtHeader>
      <Container size="lg">
        <Section title="Username" description="Shown on the decks and binders you share.">
          <UsernameForm account={account} />
        </Section>
        <Section title="Email" description="Private. Only used for account emails.">
          <Text>{account.email}</Text>
        </Section>
        <Section title="Password">
          <PasswordForm />
        </Section>
        <Section title="Delete account" description="Removes your account and all your data for good.">
          <DeleteAccount onLeave={() => setLeaving(true)} />
        </Section>
      </Container>
    </>
  )
}
