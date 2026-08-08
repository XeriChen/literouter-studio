import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
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
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载中...</div>
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
