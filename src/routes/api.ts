import { Hono } from 'hono'
import { authMiddleware } from '../middlewares/auth'
import type { Env } from '../types'
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from './api/auth'
import { registerBackupRoutes } from './api/backup'
import { registerLogRoutes } from './api/logs'
import { registerModelRoutes } from './api/models'
import { registerProviderRoutes } from './api/providers'
import { registerSettingsRoutes } from './api/settings'

export const api = new Hono<Env>()

registerPublicAuthRoutes(api)
api.use('*', authMiddleware)
registerProtectedAuthRoutes(api)
registerSettingsRoutes(api)
registerProviderRoutes(api)
registerModelRoutes(api)
registerLogRoutes(api)
registerBackupRoutes(api)
