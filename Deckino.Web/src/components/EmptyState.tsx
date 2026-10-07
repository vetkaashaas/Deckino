import { Stack, Text, Title } from '@mantine/core'
import type { ReactNode } from 'react'

// An empty page or list is an invitation to act: say what belongs here and how to get it there.
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Stack align="flex-start" gap="xs" py="xl" maw={520}>
      <Title order={3}>{title}</Title>
      {children && <Text c="dimmed">{children}</Text>}
      {action}
    </Stack>
  )
}
