import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/home.tsx'),
  route('setup', 'routes/setup.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.ts'),
  route('locale', 'routes/locale.ts'),
  route('links', 'routes/links.tsx'),
  route('links/new', 'routes/link-new.tsx'),
  route('links/:id', 'routes/link-edit.tsx'),
] satisfies RouteConfig
