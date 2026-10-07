import { createContext, useContext } from 'react'

export interface Account {
  id: string
  username: string
  email: string
}

export interface Auth {
  // undefined while the first /me request is in flight, null when signed out.
  account: Account | null | undefined
  setAccount: (account: Account | null) => void
  logout: () => Promise<void>
}

export const AuthContext = createContext<Auth | null>(null)

export function useAuth() {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth needs an AuthProvider')
  return auth
}
