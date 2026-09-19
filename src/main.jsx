import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AppShell from './AppShell.jsx'
import { installErrorReporting } from './monetisation/errors.js'

// Before the first render, so a failure while the app is starting up is reported too
// — that is precisely the kind of error nobody can describe to you afterwards.
installErrorReporting()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
