import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Mini } from './Mini'
import './theme.css'

const isMini = new URLSearchParams(window.location.search).get('view') === 'mini'
if (isMini) document.documentElement.dataset.view = 'mini'
createRoot(document.getElementById('root')!).render(isMini ? <Mini /> : <App />)
