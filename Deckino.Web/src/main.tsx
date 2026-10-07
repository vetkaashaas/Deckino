import '@fontsource-variable/bricolage-grotesque/opsz.css'
import '@fontsource-variable/lexend'
import '@mantine/core/styles.layer.css'
import './index.css'
import { MantineProvider } from '@mantine/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { theme } from './theme'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
)
