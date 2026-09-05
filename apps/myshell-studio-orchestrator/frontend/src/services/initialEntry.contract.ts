import { resolveInitialEntry, resolveSpaPathEntry } from './initialEntry';

const libraryDetailPathContract = resolveSpaPathEntry({
  pathname: '/library/studio-preview',
  search: '',
});

const energyHistoryPathContract = resolveInitialEntry({
  pathname: '/energy-history',
  search: '',
});

const canvasProPathContract = resolveInitialEntry({
  pathname: '/canvaspro',
  search: '',
});

const botPathContract = resolveInitialEntry({
  pathname: '/bot',
  search: '?slug_id=luna-star',
});

const pageParamStillWinsContract = resolveInitialEntry({
  pathname: '/',
  search: '?page=library-detail&id=studio-preview',
});

const rootSlugFallbackContract = resolveInitialEntry({
  pathname: '/',
  search: '?slug_id=luna-star',
});

const startAppLibraryDetailContract = resolveInitialEntry({
  pathname: '/',
  search: '?startapp=library-detail',
});

const telegramStartParamLibraryDetailContract = resolveInitialEntry({
  pathname: '/',
  search: '',
  telegramStartParam: 'page=library-detail&id=artifact-123',
});

const startAppWinsOverAttributionSlugContract = resolveInitialEntry({
  pathname: '/',
  search: '?startapp=library-detail&slug_id=luna-star',
});

const queryStartAppSlugContract = resolveInitialEntry({
  pathname: '/',
  search: '?startapp=slug_id=luna-star',
});

void libraryDetailPathContract;
void energyHistoryPathContract;
void canvasProPathContract;
void botPathContract;
void pageParamStillWinsContract;
void rootSlugFallbackContract;
void startAppLibraryDetailContract;
void telegramStartParamLibraryDetailContract;
void startAppWinsOverAttributionSlugContract;
void queryStartAppSlugContract;
