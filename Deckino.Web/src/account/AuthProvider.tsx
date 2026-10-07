import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { getJson, sendJson } from '../api'
import { AuthContext, type Account } from './auth'

// Who is signed in, from the auth cookie (which JavaScript can't read): asked once on load, then kept
// up to date by the login, account and logout pages.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>()

  useEffect(() => {
    getJson<Account>('/api/account/me')
      .then(setAccount)
      .catch(() => setAccount(null))
  }, [])

  const auth = useMemo(
    () => ({
      account,
      setAccount,
      logout: async () => {
        await sendJson('POST', '/api/account/logout')
        setAccount(null)
      },
    }),
    [account],
  )
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}
