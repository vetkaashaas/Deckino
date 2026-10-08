import { Anchor, Text } from '@mantine/core'

// Wizards of the Coast's Fan Content Policy notice, required wherever the site shows card content.
export function FanContentNotice() {
  return (
    <Text size="xs" c="dimmed">
      Deckino is unofficial Fan Content permitted under the{' '}
      <Anchor href="https://company.wizards.com/en/legal/fancontentpolicy" size="xs">
        Fan Content Policy
      </Anchor>
      . Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast.
      ©Wizards of the Coast LLC.
    </Text>
  )
}
