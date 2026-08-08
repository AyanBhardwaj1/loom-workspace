import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { UserPublic } from '@loom/shared'
import { api, ApiError } from '../lib/api'
import { wsClient } from '../lib/ws'

interface AuthState {
  user: UserPublic | null
  loading: boolean
  /** dev-mode features available (quick-login, ghost) */
  devMode: boolean
  devUsers: UserPublic[]
  login(email: string, password: string): Promise<void>
  signup(name: string, email: string, password: string): Promise<void>
  devLogin(userId: string): Promise<void>
  logout(): Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null)
  const [loading, setLoading] = useState(true)
  const [devMode, setDevMode] = useState(false)
  const [devUsers, setDevUsers] = useState<UserPublic[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ user: UserPublic }>('/api/auth/me')
        setUser(res.user)
      } catch {
        setUser(null)
      }
      try {
        const res = await api.get<{ users: UserPublic[] }>('/api/auth/dev-users')
        setDevMode(true)
        setDevUsers(res.users)
      } catch {
        setDevMode(false)
      }
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (user) {
      wsClient.connect()
      return () => wsClient.disconnect()
    }
  }, [user?.id])

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ user: UserPublic }>('/api/auth/login', { email, password })
    setUser(res.user)
  }, [])

  const signup = useCallback(async (name: string, email: string, password: string) => {
    const res = await api.post<{ user: UserPublic }>('/api/auth/signup', { name, email, password })
    setUser(res.user)
  }, [])

  const devLogin = useCallback(async (userId: string) => {
    const res = await api.post<{ user: UserPublic }>('/api/auth/dev-login', { userId })
    setUser(res.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout')
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, devMode, devUsers, login, signup, devLogin, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
