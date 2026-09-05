import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { notePageView } from '../services/session';

/**
 * Must live inside <MemoryRouter>. Records each path change so session_end
 * can report an accurate page_views count + last_route.
 */
export default function RouteObserver() {
  const location = useLocation();
  useEffect(() => {
    notePageView(location.pathname);
  }, [location.pathname]);
  return null;
}
