import React from 'react';
import { createRoot } from 'react-dom/client';
import '../motion-tokens.css';
import '../styles.css';
import './saas.css';
import { ErrorBoundary } from '../ErrorBoundary';
import { SaaSApp } from './SaaSApp';
import { installNavigationFeedback } from './navigation';
import { installStaleBuildWatch } from './staleBuild';
import { installFeedbackDiagnostics } from './feedbackDiagnostics';
import '../canvas/ios-theme.css';
// The hosted app's design system, after the shared sheets it refines: tokens first, then components.
import './design/tokens.css';
// The appearance styles (外观风格): each one's values, over the tokens' defaults.
import './design/themes.css';
import './design/system.css';
import './design/canvas.css';
import './design/surfaces.css';
import './design/motion.css';
import './design/modes.css';
import './design/transitions.css';

installNavigationFeedback();
installStaleBuildWatch();
// What the feedback assistant sends with a report: the script errors this page meets (FeedbackAssistant.tsx).
installFeedbackDiagnostics();
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><SaaSApp /></ErrorBoundary></React.StrictMode>);
