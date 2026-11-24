import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './bui/bui-utilities.css'
import './bui/bui-reset.css'
import './bui/bui-foundation.css'
import './sealed-ui.css'

const root = document.querySelector('#root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
