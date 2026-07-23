import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRouter } from './AppRouter.tsx'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('React root element를 찾을 수 없습니다.')
}

createRoot(rootElement).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
)
