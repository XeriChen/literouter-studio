import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { getToken } from './api/client'
import { Layout } from './components/Layout'
import Home from './pages/Home'
import Login from './pages/Login'

// 路由级代码分割：减小首屏 bundle 体积
const Providers = lazy(() => import('./pages/Providers'))
const Models = lazy(() => import('./pages/Models'))
const Logs = lazy(() => import('./pages/Logs'))
const Settings = lazy(() => import('./pages/Settings'))
const Playground = lazy(() => import('./pages/Playground'))

function RequireAuth({ children }: { children: React.ReactNode }) {
  return getToken() ? children : <Navigate to="/login" replace />
}

function PageFallback() {
  return (
    <div className="page-shell space-y-6 animate-pulse">
      <div className="space-y-2 border-b border-foreground/10 pb-6">
        <div className="h-3 w-20 rounded bg-muted" />
        <div className="h-8 w-44 rounded bg-muted" />
        <div className="h-4 w-72 rounded bg-muted" />
      </div>
      <div className="h-64 rounded-lg border border-foreground/10 bg-card/40" />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route path="providers" element={<Suspense fallback={<PageFallback />}><Providers /></Suspense>} />
          <Route path="models" element={<Suspense fallback={<PageFallback />}><Models /></Suspense>} />
          <Route path="logs" element={<Suspense fallback={<PageFallback />}><Logs /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<PageFallback />}><Settings /></Suspense>} />
          <Route path="playground" element={<Suspense fallback={<PageFallback />}><Playground /></Suspense>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
