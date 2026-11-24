import { Anchor, Container, List, Stack, Text, Title } from '@mantine/core'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

// The privacy policy (/privacy) and terms of service (/terms), on the usual SaaS outline. Both describe what the
// code actually does (Mailgun, Railway, the opt-in training photos, one login cookie): change them with it.
const CONTACT = 'hello@deckino.com'
const JURISDICTION = 'the Republic of South Africa'
const UPDATED = '24 November 2026'

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md" maw={720}>
        <Title order={1}>{title}</Title>
        <Text size="sm" c="dimmed">
          Last updated {UPDATED}
        </Text>
        {children}
      </Stack>
    </Container>
  )
}

const H = ({ children }: { children: ReactNode }) => (
  <Title order={2} size="h3" mt="lg">
    {children}
  </Title>
)
const P = ({ children }: { children: ReactNode }) => <Text>{children}</Text>
const Mail = () => <Anchor href={`mailto:${CONTACT}`}>{CONTACT}</Anchor>

export function PrivacyPage() {
  return (
    <Page title="Privacy Policy">
      <P>
        This policy explains what personal information Deckino (“we”, “us”) collects when you use the website at deckino.com and the Deckino mobile app (together, the “Service”), how we
        use it, and the choices you have. We keep it short because we collect little: we don’t run ads, we don’t use
        third-party analytics or tracking, and we don’t sell your data.
      </P>

      <H>Information we collect</H>
      <List spacing="xs">
        <List.Item>
          <b>Account information.</b> Your email address, username and password (stored only as a salted hash). If you
          sign in with Google or Apple, we receive your account identifier and email address from them.
        </List.Item>
        <List.Item>
          <b>Your content.</b> The decks, binders, collection, wishlist and settings you create. These are private
          unless you make one public, in which case anyone with the link can see it along with your username.
        </List.Item>
        <List.Item>
          <b>Scanner photos, only if you opt in.</b> Card recognition runs on your phone, and scan photos stay there
          by default. If you choose “Help the scanner get better”, we receive the photo of each card you scan and what
          the scanner thought it was. Nothing else from your phone is sent. You can turn this off at any time in the
          app under Profile, Privacy.
        </List.Item>
        <List.Item>
          <b>Technical information.</b> Like most web services, our servers record IP addresses, request times and
          pages requested, to keep the Service secure (for example, to limit repeated login attempts) and to fix
          problems.
        </List.Item>
      </List>

      <H>How we use it</H>
      <List spacing="xs">
        <List.Item>To provide the Service: your account, your decks and collection, prices and sharing.</List.Item>
        <List.Item>To send account emails: verification, password resets and important notices. No marketing without your consent.</List.Item>
        <List.Item>To train and test the card scanner, with photos you chose to share.</List.Item>
        <List.Item>To keep the Service secure, prevent abuse and comply with the law.</List.Item>
      </List>
      <P>
        Where data protection law requires a legal basis, we rely on performing our contract with you (running your
        account), your consent (scanner photos, which you can withdraw), and our legitimate interests (security and
        improving the Service).
      </P>

      <H>Cookies and local storage</H>
      <P>
        The website sets one essential cookie that keeps you signed in, and remembers a few display choices (such as
        your currency) in your browser’s local storage. We use no advertising or analytics cookies, so there is
        nothing to opt out of.
      </P>

      <H>Who we share it with</H>
      <P>We share personal information only with service providers that help us run Deckino, under contracts that limit their use of it:</P>
      <List spacing="xs">
        <List.Item>Railway, which hosts our servers, database and file storage;</List.Item>
        <List.Item>Mailgun, which delivers our account emails;</List.Item>
        <List.Item>Google and Apple, if you choose to sign in with them;</List.Item>
        <List.Item>Scryfall, which serves some card symbols your browser loads directly.</List.Item>
      </List>
      <P>
        We may also disclose information if the law requires it, to protect the rights and safety of our users or
        others, or as part of a merger or sale of the Service, in which case this policy continues to apply.
      </P>

      <H>Where it is stored</H>
      <P>
        Our providers may process data outside your country, including in the United States. Where required, we rely
        on appropriate safeguards such as the European Commission’s Standard Contractual Clauses.
      </P>

      <H>How long we keep it</H>
      <P>
        We keep your account and content until you delete your account. Deleting it, from the account page on the
        website or in the app, permanently removes your account and everything in it. Card photos you shared to train
        the scanner are kept as training data after that, but they can no longer be connected to you. Server logs are kept for a limited period and backups are overwritten on a
        rolling schedule.
      </P>

      <H>Your rights</H>
      <P>
        Depending on where you live, you may have the right to access, correct, export or delete your personal
        information, to object to or restrict how we use it, and to withdraw consent. You can do most of this yourself
        in your account settings; for anything else, email <Mail />. You may also complain to your local data
        protection authority (in South Africa, the Information Regulator).
      </P>

      <H>Security</H>
      <P>
        We use encryption in transit (HTTPS), hashed passwords, private storage and access controls to protect your
        information. No service is perfectly secure, so please use a strong, unique password.
      </P>

      <H>Children</H>
      <P>
        Deckino is not directed at children under 13 (or the minimum age in your country), and we don’t knowingly
        collect their information. If you believe a child has given us personal information, contact us and we will
        delete it.
      </P>

      <H>Changes</H>
      <P>
        We may update this policy. We’ll change the date above, and for significant changes we’ll let you know by
        email or in the Service before they take effect.
      </P>

      <H>Contact</H>
      <P>
        Questions about privacy: <Mail />.
      </P>
    </Page>
  )
}

export function TermsPage() {
  return (
    <Page title="Terms of Service">
      <P>
        These terms govern your use of Deckino’s website and mobile app (the “Service”), run by Deckino (“we”,
        “us”). By creating an account or using the Service, you agree to them. If you don’t agree,
        please don’t use the Service.
      </P>

      <H>Your account</H>
      <P>
        You must be at least 13 (or the minimum age in your country) to use Deckino. Give us accurate information,
        keep your password safe, and tell us if you think someone else has used your account. You are responsible for
        what happens under your account.
      </P>

      <H>Your content</H>
      <P>
        You own the decks, binders, lists and other content you add. You give us a worldwide, non-exclusive,
        royalty-free licence to store, display and process it only as needed to run the Service, including showing
        content you make public to anyone with its link. If you share scanner photos, you also let us use them to
        train and improve the scanner, and we may keep those photos as training data after your account is
        deleted. You can delete your content or account at any time.
      </P>

      <H>Acceptable use</H>
      <P>You agree not to:</P>
      <List spacing="xs">
        <List.Item>break the law or infringe anyone else’s rights;</List.Item>
        <List.Item>post content that is abusive, hateful, sexually explicit or misleading in a public name, deck or binder;</List.Item>
        <List.Item>access accounts or data that aren’t yours, or probe, disrupt or overload the Service;</List.Item>
        <List.Item>scrape the Service or use bots beyond normal personal use;</List.Item>
        <List.Item>copy, extract, reverse engineer or redistribute the app, its recognition models or data, except where the law allows it.</List.Item>
      </List>
      <P>We may remove content or suspend accounts that break these rules.</P>

      <H>Card data, prices and Wizards of the Coast</H>
      <P>
        Deckino is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy and is not
        approved or endorsed by Wizards. Card names, images and other Magic: The Gathering materials are the property
        of Wizards of the Coast LLC. Card data and images are provided courtesy of Scryfall. Prices and collection
        values are estimates for information only, may be delayed or wrong, and are not financial advice.
      </P>

      <H>Paid plans</H>
      <P>
        Deckino is free today. If we offer paid plans, their price, billing and cancellation terms will be shown
        before you buy. Purchases made through the App Store or Google Play are also governed by their terms.
      </P>

      <H>Our service</H>
      <P>
        The Deckino name, logo, software and design belong to us. We may change, add or remove features, and we may
        suspend or end the Service. If we end it, we’ll give reasonable notice where we can so you can export your
        data.
      </P>

      <H>Disclaimers</H>
      <P>
        The Service is provided “as is” and “as available”, without warranties of any kind, including fitness for a
        particular purpose, accuracy (for example of card recognition or prices) or uninterrupted availability.
      </P>

      <H>Limitation of liability</H>
      <P>
        To the extent the law allows, Deckino is not liable for indirect, incidental, special or consequential damages,
        or for lost data, profits or goodwill, and our total liability for any claim is limited to the greater of the
        amount you paid us in the 12 months before the claim or US$50. Nothing in these terms limits liability that
        cannot be limited by law, or your rights as a consumer.
      </P>

      <H>Ending your use</H>
      <P>
        You can stop using Deckino and delete your account at any time. We may suspend or end your access if you
        seriously or repeatedly break these terms. The sections on content licences you granted for public content
        already shared, disclaimers and liability survive termination.
      </P>

      <H>Changes to these terms</H>
      <P>
        We may update these terms. We’ll change the date above, and for significant changes we’ll let you know before
        they take effect. Continuing to use the Service after that means you accept the new terms.
      </P>

      <H>Governing law</H>
      <P>
        These terms are governed by the laws of {JURISDICTION}, without regard to its conflict-of-law rules. If you are
        a consumer, you also keep the protection of the mandatory laws of the country you live in.
      </P>

      <H>Contact</H>
      <P>
        Questions about these terms: <Mail />. How we handle personal information is described in our{' '}
        <Anchor component={Link} to="/privacy">
          Privacy Policy
        </Anchor>
        .
      </P>
    </Page>
  )
}
