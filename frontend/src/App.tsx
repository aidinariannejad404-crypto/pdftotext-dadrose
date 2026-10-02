import { useEffect, useState } from 'react';
import { AppDataProvider } from './appData';
import ProjectsPage from './components/ProjectsPage';
import QueuePage from './components/QueuePage';
import ReviewPage from './components/ReviewPage';
import { ToastProvider } from './components/Toasts';

type Route = { name: 'projects' } | { name: 'queue' } | { name: 'review'; id: string };

function parseHash(): Route {
  const m = /^#\/p\/([^/?#]+)/.exec(window.location.hash);
  if (m) return { name: 'review', id: decodeURIComponent(m[1]) };
  if (/^#\/queue/.test(window.location.hash)) return { name: 'queue' };
  return { name: 'projects' };
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <ToastProvider>
      <AppDataProvider>
        {route.name === 'review' ? <ReviewPage key={route.id} id={route.id} /> : route.name === 'queue' ? <QueuePage /> : <ProjectsPage />}
      </AppDataProvider>
    </ToastProvider>
  );
}
