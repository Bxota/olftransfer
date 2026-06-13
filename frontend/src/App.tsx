import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import HomePage from './pages/HomePage'
import TransferPage from './pages/TransferPage'
import AdminPage from './pages/AdminPage'
import RequestDropPage from './pages/RequestDropPage'

export interface User {
  email: string
  is_admin: boolean
  storage_quota_bytes: number
  storage_used_bytes: number
}

interface AuthContextType {
  user: User | null
  loading: boolean
  setUser: (u: User | null) => void
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  setUser: () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(u => {
        setUser(u)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, setUser }}>
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
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
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
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
