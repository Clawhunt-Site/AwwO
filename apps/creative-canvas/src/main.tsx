import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';
import './standalone.css';

const element = document.getElementById('root');
if (!element) throw new Error('root element missing');

createRoot(element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
