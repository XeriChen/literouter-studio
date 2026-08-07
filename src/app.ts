import { Hono } from 'hono'
import { api } from './routes/api'
import { proxyRoutes } from './routes/proxy'
import { errorMiddleware } from './middlewares/error'
import type { Env } from './types'

export const app = new Hono<Env>()

app.use('*', errorMiddleware)

app.route('/api', api)
app.route('/openai', proxyRoutes)
app.route('/anthropic', proxyRoutes)