import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'

// The app's toast: one short message at the bottom, with Undo for a change that can be put back (undo over
// "Are you sure?"). A new one replaces the last.
let shown = 0

export function showToast({ message, undo, error = false }: { message: string; undo?: () => void; error?: boolean }) {
  notifications.clean()
  const id = `toast-${++shown}`
  notifications.show({
    id,
    color: error ? 'danger' : 'purple',
    autoClose: undo ? 8000 : 4000,
    message: undo ? (
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">{message}</Text>
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => {
            notifications.hide(id)
            undo()
          }}
        >
          Undo
        </Button>
      </Group>
    ) : (
      message
    ),
  })
}
