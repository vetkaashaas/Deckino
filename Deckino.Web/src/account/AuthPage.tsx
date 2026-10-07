import { Container, Stack, Text, Title } from '@mantine/core'
import type { ReactNode } from 'react'
import classes from './AuthPage.module.css'

// The narrow single-panel layout shared by the sign-up, log-in and password pages.
export function AuthPage({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Container size={460} py="xl">
      <Stack gap="xs" mb="lg">
        <Title order={1} className={classes.title}>
          {title}
        </Title>
        {intro && <Text c="dimmed">{intro}</Text>}
      </Stack>
      <div className={classes.panel}>{children}</div>
    </Container>
  )
}
