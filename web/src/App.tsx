import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { getToken } from './api/client'
import { Layout } from './components/Layout'
import Login from './pages/Login'
import Logs from './pages/Logs'
import Models from './pages/Models'
import Playground from './pages/Playground'
import Providers from './pages/Providers'
import Settings from './pages/Settings'

function RequireAuth({ children }: { children: React.ReactNode }) {
  return getToken() ? children : <Navigate to="/login" replace />
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
          <Route index element={<Providers />} />
          <Route path="models" element={<Models />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<Settings />} />
          <Route path="playground" element={<Playground />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}