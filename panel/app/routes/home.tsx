import { redirect } from 'react-router'
import { getSession } from '~/lib/auth.server.ts'
import { isClaimed } from '~/lib/setup.server.ts'

// The index is a signpost, never a page: where a visitor belongs depends on
// whether this installation has an owner yet and whether they are signed in.
export async function loader({ request }: { request: Request }) {
  if (!(await isClaimed())) throw redirect('/setup')
  const session = await getSession(request)
  throw redirect(session ? '/links' : '/login')
}

export default function Home() {
  return null
}
