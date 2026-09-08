import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './saas.css';
import { ErrorBoundary } from '../ErrorBoundary';
import { SaaSApp } from './SaaSApp';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><SaaSApp /></ErrorBoundary></React.StrictMode>);
