import { ActionIcon, TextInput, Title, Tooltip } from '@mantine/core'
import { useRef, useState } from 'react'
import classes from './EditableTitle.module.css'
import { Icon } from './Icon'

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
    // The pencil sits inline after the last word, so a title that wraps keeps it beside the text.
    <Title order={1} className={classes.title}>
      {/* Clicking the name renames too; the pencil is the keyboard's way in. A span, so the name wraps like text. */}
      <span className={classes.button} onClick={start}>
        {name}
      </span>
      <Tooltip label={renameLabel}>
        <ActionIcon variant="subtle" color="gray" size="lg" aria-label={renameLabel} onClick={start} className={classes.pencil}>
          <Icon name="edit" size={20} />
        </ActionIcon>
      </Tooltip>
    </Title>
  )
}
