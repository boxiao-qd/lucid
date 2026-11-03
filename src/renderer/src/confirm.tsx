import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ConfirmOverlay from './components/ConfirmOverlay'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmOverlay />
  </StrictMode>
)
