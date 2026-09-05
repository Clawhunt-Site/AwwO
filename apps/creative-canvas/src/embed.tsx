import { App } from './App';
import './styles.css';

export function CreativeCanvasSurface(_: { locale?: 'en' | 'zh'; theme?: 'light' | 'dark' } = {}) {
  return (
    <div className="creative-canvas-surface">
      <App />
    </div>
  );
}

export default CreativeCanvasSurface;
