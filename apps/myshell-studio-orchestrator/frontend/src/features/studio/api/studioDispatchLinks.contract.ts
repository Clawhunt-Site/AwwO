import {
  getStudioDispatchSelectionPageIds,
  getStudioDispatchTargetHref,
  toggleStudioDispatchPageSelection,
  type KnownStudioApi,
  type StudioDispatchMatrixEntry,
} from './index';

const coreStudioPageCoverage: Record<KnownStudioApi, true> = {
  'dreamy-miniapp': true,
  'myshell-art': true,
  explore: true,
  'ai-picks': true,
  'bot-detail': true,
  upload: true,
  'tag-generator': true,
  library: true,
  'library-detail': true,
  'energy-store': true,
  'energy-history': true,
  earn: true,
  'share-invite': true,
  settings: true,
  profile: true,
  checkin: true,
};

void coreStudioPageCoverage;

const navigationEntry: StudioDispatchMatrixEntry = {
  pageId: 'library-detail',
  pageName: 'Library Detail',
  kind: 'miniapp-page',
  executor: 'navigation',
  agentId: 'miniapp-page-navigator',
  recommendedAction: 'navigate',
  dispatchReady: true,
  dispatchStatus: 'ready',
  authStatus: { status: 'client_delegated' },
  clientAction: 'navigate',
  navigationPath: '/library/artifact-123',
  studioReturnPath: '/dreamy',
  routeParams: ['id'],
  missingRouteParams: [],
  capabilities: ['open-page'],
};

const absoluteNavigationEntry: StudioDispatchMatrixEntry = {
  ...navigationEntry,
  pageId: 'profile',
  pageName: 'Profile',
  navigationPath: 'https://app.example.test/profile',
};

const serverEntry: StudioDispatchMatrixEntry = {
  ...navigationEntry,
  pageId: 'myshell-art',
  pageName: 'MyShell Art',
  executor: 'server',
  recommendedAction: 'execute-server',
  clientAction: undefined,
  navigationPath: undefined,
  routeParams: [],
};

const dispatchTargetHrefContract = [
  getStudioDispatchTargetHref(navigationEntry),
  getStudioDispatchTargetHref(absoluteNavigationEntry),
  getStudioDispatchTargetHref(serverEntry),
];

void dispatchTargetHrefContract;

const matrixEntries: StudioDispatchMatrixEntry[] = [
  { ...navigationEntry, pageId: 'explore', pageName: 'Explore', navigationPath: '/' },
  { ...navigationEntry, pageId: 'library-detail', pageName: 'Library Detail', navigationPath: '/library/studio-preview' },
  { ...navigationEntry, pageId: 'profile', pageName: 'Profile', navigationPath: '/profile' },
];

const toggledSelectionContract = toggleStudioDispatchPageSelection(['profile'], 'library-detail');
const selectedPageIdsContract = getStudioDispatchSelectionPageIds(matrixEntries, ['profile', 'missing-page', 'library-detail']);

void toggledSelectionContract;
void selectedPageIdsContract;
