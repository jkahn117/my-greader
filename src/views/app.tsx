import type { JSX } from 'hono/jsx/jsx-runtime'
import { Layout } from './layout'
import { Header } from './components/header'
import { Tabs, type ActiveTab } from './components/tabs'

interface AppProps {
  email: string
  active: ActiveTab
  children: JSX.Element | JSX.Element[]
}

/** Top-level page shell: layout + header + tabs + tab content */
export function App({ email, active, children }: AppProps) {
  return (
    <Layout>
      <Header email={email} />
      <Tabs active={active} />
      <main class="mx-auto max-w-4xl px-4 py-8">
        {children}
      </main>
    </Layout>
  )
}
