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
  route('links/bulk', 'routes/links.bulk.tsx'),
  route('domains', 'routes/domains.tsx'),
  route('members', 'routes/members.tsx'),
  route('reports', 'routes/reports.tsx'),
  route('reports/export', 'routes/reports.export.ts'),
  route('trash', 'routes/trash.tsx'),
  route('join', 'routes/join.tsx'),
] satisfies RouteConfig
