import React from 'react'
import { NavLink } from 'react-router-dom'

const NAV_ITEMS = [
  { to: '/', label: 'Providers', end: true },
  { to: '/models', label: 'Models', end: false },
  { to: '/logs', label: 'Logs', end: false },
  { to: '/playground', label: 'Playground', end: false },
  { to: '/settings', label: 'Settings', end: false },
]

export function Layout({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="w-48 shrink-0 border-r p-4">
        <div className="mb-6 text-sm font-semibold">LLM Gateway</div>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.label}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `block rounded px-3 py-2 text-sm ${
                    isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted'
                  }`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}