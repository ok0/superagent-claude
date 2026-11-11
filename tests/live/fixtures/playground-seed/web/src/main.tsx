import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App.tsx'
import { createTaskClient } from './api/client.ts'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('missing #root element')

createRoot(root).render(
  <StrictMode>
    <App client={createTaskClient({ baseUrl: '/api', token: String(import.meta.env.VITE_API_TOKEN ?? '') })} />
  </StrictMode>,
)
