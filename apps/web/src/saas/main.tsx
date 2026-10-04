import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './saas.css';
import { ErrorBoundary } from '../ErrorBoundary';
import { SaaSApp } from './SaaSApp';
import '../canvas/ios-theme.css';
// The hosted app's design system, after the shared sheets it refines: tokens first, then components.
import './design/tokens.css';
import './design/system.css';
import './design/canvas.css';
import './design/motion.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><SaaSApp /></ErrorBoundary></React.StrictMode>);
