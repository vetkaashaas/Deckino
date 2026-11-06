import { Alert, Button, Container, Group, Modal, PasswordInput, Select, Stack, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { sendJson } from '../api'
import { conditions, languages, useDefaultCondition, useDefaultLanguage, type Condition } from '../binders/binder'
import { ArtHeader } from '../components/ArtHeader'
import { useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { useAuth, type Account } from './auth'
import classes from './AccountPage.module.css'
import { rules, useApiSubmit } from './forms'

// A group of settings: a heading over a panel of rows.
function Panel({ title, danger, children }: { title?: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className={classes.group}>
      {title && (
        <Title order={2} className={classes.groupTitle}>
          {title}
        </Title>
      )}
      <div className={classes.panel} data-danger={danger || undefined}>
        {children}
      </div>
    </div>
  )
}

// One setting: what it is on the left, its value or controls, then its button. Without a button (a form open in
// place) the controls take the rest of the row.
function Row({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className={classes.row} aria-label={title}>
      <div className={classes.label}>
        <Title order={3} className={classes.rowTitle}>
          {title}
        </Title>
        {description && (
          <Text c="dimmed" size="sm" mt={2}>
            {description}
          </Text>
        )}
      </div>
      <div className={classes.value}>{children}</div>
      {action && <div className={classes.action}>{action}</div>}
    </section>
  )
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" c="success" role="status" mt={4}>
      {children}
    </Text>
  )
}

function UsernameRow({ account }: { account: Account }) {
  const { setAccount } = useAuth()
  const [editing, edit] = useDisclosure()
  const [saved, setSaved] = useState(false)
  const form = useForm({ initialValues: { username: account.username }, validate: { username: rules.username } })
  const { submit, error, submitting } = useApiSubmit(form)
  const description = 'Shown on the decks and binders you share.'

  if (!editing)
    return (
      <Row
        title="Username"
        description={description}
        action={
          <Button variant="default" size="xs" aria-label="Edit username" onClick={() => {
            setSaved(false)
            form.setValues({ username: account.username }) // the name as it is now, renamed or not
            form.clearErrors()
            edit.open()
          }}>
            Edit
          </Button>
        }
      >
        <Text fw={600} className={classes.text}>
          {account.username}
        </Text>
        {saved && <Saved>Username saved</Saved>}
      </Row>
    )

  return (
    <Row title="Username" description={description}>
      <form
        onSubmit={submit(async (values) => {
          const answer = await sendJson('PUT', '/api/account/username', values)
          if ('id' in answer) setAccount(answer) // the app gets a token pair instead
          setSaved(true)
          edit.close()
        })}
        noValidate
      >
        <Stack gap="sm">
          {error && <Alert color="danger" role="alert">{error}</Alert>}
          <TextInput aria-label="Username" autoComplete="username" maw={360} autoFocus {...form.getInputProps('username')} />
          <Group gap="xs">
            <Button type="submit" size="xs" loading={submitting}>
              Save username
            </Button>
            <Button variant="subtle" color="gray" size="xs" onClick={edit.close}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
    </Row>
  )
}

// Changing the password happens in a dialog, like deleting the account; the row says when it's done.
function PasswordRow() {
  const [open, dialog] = useDisclosure()
  const [saved, setSaved] = useState(false)
  const form = useForm({
    initialValues: { currentPassword: '', newPassword: '' },
    validate: { currentPassword: rules.required, newPassword: rules.password },
  })
  const { submit, error, submitting } = useApiSubmit(form)
  const close = () => {
    form.reset()
    dialog.close()
  }

  return (
    <Row
      title="Password"
      action={
        <Button
          variant="default"
          size="xs"
          aria-label="Change password"
          onClick={() => {
            setSaved(false)
            dialog.open()
          }}
        >
          Change
        </Button>
      }
    >
      <Text className={classes.text} aria-hidden="true">
        ••••••••
      </Text>
      {saved && <Saved>Password changed. Other devices are logged out.</Saved>}
      <Modal opened={open} onClose={close} title="Change your password" centered>
        <form
          onSubmit={submit(async (values) => {
            await sendJson('PUT', '/api/account/password', values)
            setSaved(true)
            close()
          })}
          noValidate
        >
          <Stack gap="md">
            {error && <Alert color="danger" role="alert">{error}</Alert>}
            <PasswordInput
              label="Current password"
              autoComplete="current-password"
              data-autofocus
              {...form.getInputProps('currentPassword')}
            />
            <PasswordInput
              label="New password"
              description="At least 8 characters."
              autoComplete="new-password"
              {...form.getInputProps('newPassword')}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                Change password
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Row>
  )
}

function NewCardDefaults() {
  const [condition, setCondition] = useDefaultCondition()
  const [language, setLanguage] = useDefaultLanguage()
  return (
    <Group gap="sm" align="flex-end">
      <Select
        label="Condition"
        data={conditions}
        value={condition}
        allowDeselect={false}
        onChange={(v) => v && setCondition(v as Condition)}
        w={180}
      />
      <Select label="Language" data={languages} value={language} allowDeselect={false} onChange={(v) => v && setLanguage(v)} w={180} />
    </Group>
  )
}

function CurrencySetting() {
  const [currency, setCurrency] = useCurrency()
  return <CurrencyToggle currency={currency} onChange={setCurrency} />
}

function DeleteAccount({ onLeave }: { onLeave: () => void }) {
  const { setAccount } = useAuth()
  const navigate = useNavigate()
  const [open, dialog] = useDisclosure()
  const form = useForm({ initialValues: { password: '' }, validate: { password: rules.required } })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <>
      <Button color="danger" variant="light" size="xs" onClick={dialog.open}>
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
            {error && <Alert color="danger" role="alert">{error}</Alert>}
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
              <Button type="submit" color="danger" loading={submitting}>
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

  const since = new Date(account.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  return (
    <>
      <ArtHeader>
        <div className={classes.identity}>
          {/* The top bar's avatar, bigger. */}
          <span className={classes.avatar} aria-hidden="true">
            {account.username.slice(0, 1).toUpperCase()}
          </span>
          <div className={classes.who}>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" className={classes.eyebrow}>
              Your account
            </Text>
            <Title order={1} className={classes.name}>
              {account.username}
            </Title>
            <Text size="sm" c="dimmed">
              Member since {since}
            </Text>
          </div>
          <Button
            variant="default"
            className={classes.logOut}
            onClick={async () => {
              setLeaving(true)
              await logout()
              navigate('/', { replace: true })
            }}
          >
            Log out
          </Button>
        </div>
      </ArtHeader>
      <Container size="lg">
        <Panel title="Account">
          <UsernameRow account={account} />
          <Row title="Email" description="Private. Only used for account emails.">
            <Text className={classes.text}>{account.email}</Text>
          </Row>
          <PasswordRow />
        </Panel>
        <Panel title="Preferences">
          <Row title="Currency" description="Prices and values across the site. Remembered in this browser.">
            <CurrencySetting />
          </Row>
          <Row title="New cards" description="What cards you add to a binder start as; change any one from its row. Remembered in this browser.">
            <NewCardDefaults />
          </Row>
        </Panel>
        <Panel danger>
          <Row
            title="Delete account"
            description="Removes your account and all your data for good."
            action={<DeleteAccount onLeave={() => setLeaving(true)} />}
          />
        </Panel>
      </Container>
    </>
  )
}
