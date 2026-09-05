import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import HomePage from './pages/HomePage'
import TransferPage from './pages/TransferPage'
import AdminPage from './pages/AdminPage'
import RequestDropPage from './pages/RequestDropPage'
import NotFoundPage from './pages/NotFoundPage'

export interface User {
  email: string
  pseudonym: string | null
  is_admin: boolean
  storage_quota_bytes: number
  storage_used_bytes: number
}

interface AuthContextType {
  user: User | null
  loading: boolean
  accessRevoked: boolean
  setUser: (u: User | null) => void
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  accessRevoked: false,
  setUser: () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [accessRevoked, setAccessRevoked] = useState(false)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'olf-auth-event' || !event.newValue) return
      try {
        if (JSON.parse(event.newValue).type === 'logout') setUser(null)
      } catch {
        // Ignore malformed events from an unrelated client.
      }
    }
    window.addEventListener('storage', onStorage)
    fetch('/auth/me')
      .then(async r => {
        if (!r.ok) {
          setAccessRevoked(r.headers.get('X-Auth-State') === 'access-revoked')
          return null
        }
        return r.json()
      })
      .then(u => {
        setUser(u)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, accessRevoked, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

function ProtectedRoute({
  children,
  adminOnly = false,
}: {
  children: ReactNode
  adminOnly?: boolean
}) {
  const { user, loading, accessRevoked } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to={accessRevoked ? '/login?error=access_denied' : '/login'} replace />
  if (adminOnly && !user.is_admin) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/t/:token" element={<TransferPage />} />
          <Route path="/r/:token" element={<RequestDropPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <HomePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute adminOnly>
                <AdminPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
