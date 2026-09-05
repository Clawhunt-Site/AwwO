import {
  buildStudioDispatchNavigationPath,
  getStudioReturnPath,
  readStudioDispatchSessionFromUrl,
  stripStudioDispatchNavigationParams,
} from './studioSession';

const targetUrlContract = buildStudioDispatchNavigationPath('/library/artifact-123?source=matrix', {
  projectId: 'project-1',
  sessionId: 'dispatch-session-1',
  targetId: 'dispatch:library-detail',
  pageId: 'library-detail',
});

const restoredSessionContract = readStudioDispatchSessionFromUrl({
  pathname: '/library/artifact-123',
  search: '?studio_project_id=project-1&dispatch_session_id=dispatch-session-1&dispatch_target_id=dispatch%3Alibrary-detail&studio_page_id=library-detail',
});

const returnPathContract = getStudioReturnPath({
  projectId: 'project-1',
  sessionId: 'dispatch-session-1',
  targetId: 'dispatch:library-detail',
});

const strippedTargetUrlContract = stripStudioDispatchNavigationParams({
  pathname: '/library/artifact-123',
  search: '?studio_project_id=project-1&dispatch_session_id=session-1&dispatch_target_id=dispatch%3Alibrary-detail&studio_page_id=library-detail&source=matrix',
});

void targetUrlContract;
void restoredSessionContract;
void returnPathContract;
void strippedTargetUrlContract;
