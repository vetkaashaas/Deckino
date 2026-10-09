import { ActionIcon, Group, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { IconPencil } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import classes from './EditableTitle.module.css'

// A page title renamed in place: the pencil (or a click on the title) swaps it for a field; Enter or leaving the
// field keeps the new name, Escape or an empty name keeps the old one.
export function EditableTitle({
  name,
  label,
  renameLabel,
  onRename,
}: {
  name: string
  label: string
  renameLabel: string
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const cancelled = useRef(false)
  const start = () => {
    setValue(name)
    cancelled.current = false
    setEditing(true)
  }
  // Leaving the field is the one place a rename happens: Enter and Escape leave it, so it can't happen twice.
  const finish = () => {
    const next = value.trim()
    if (!cancelled.current && next && next !== name) onRename(next)
    setEditing(false)
  }
  if (editing) {
    return (
      <TextInput
        aria-label={label}
        size="lg"
        maxLength={100}
        autoFocus
        className={classes.input}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancelled.current = true
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
      />
    )
  }
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Title order={1} className={classes.title}>
        <UnstyledButton className={classes.button} onClick={start} tabIndex={-1}>
          {name}
        </UnstyledButton>
      </Title>
      <Tooltip label={renameLabel}>
        <ActionIcon variant="subtle" color="gray" size="lg" aria-label={renameLabel} onClick={start}>
          <IconPencil size={20} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
