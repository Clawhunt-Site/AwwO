import {
  MINIAPP_PAGE_DEEP_LINKS,
  resolveMiniappPageDeepLink,
  resolveStartParamDeepLink,
} from './deepLinks';

const exploreRouteContract: '/explore' = MINIAPP_PAGE_DEEP_LINKS.explore.route;
const aiPicksRouteContract: '/ai-picks' = MINIAPP_PAGE_DEEP_LINKS['ai-picks'].route;
const botDetailRouteContract: '/bot' = MINIAPP_PAGE_DEEP_LINKS['bot-detail'].route;
const uploadRouteContract: '/upload' = MINIAPP_PAGE_DEEP_LINKS.upload.route;
const tagGeneratorRouteContract: '/tag-generator' = MINIAPP_PAGE_DEEP_LINKS['tag-generator'].route;
const libraryRouteContract: '/library' = MINIAPP_PAGE_DEEP_LINKS.library.route;
const libraryDetailRouteContract: '/library/:id' = MINIAPP_PAGE_DEEP_LINKS['library-detail'].route;
const energyStoreRouteContract: '/energy' = MINIAPP_PAGE_DEEP_LINKS['energy-store'].route;
const energyHistoryRouteContract: '/energy-history' = MINIAPP_PAGE_DEEP_LINKS['energy-history'].route;
const earnRouteContract: '/earn' = MINIAPP_PAGE_DEEP_LINKS.earn.route;
const shareInviteRouteContract: '/share-invite' = MINIAPP_PAGE_DEEP_LINKS['share-invite'].route;
const settingsRouteContract: '/settings' = MINIAPP_PAGE_DEEP_LINKS.settings.route;
const profileRouteContract: '/profile' = MINIAPP_PAGE_DEEP_LINKS.profile.route;
const checkinRouteContract: '/checkin-demo' = MINIAPP_PAGE_DEEP_LINKS.checkin.route;
const dreamyRouteContract: '/dreamy' = MINIAPP_PAGE_DEEP_LINKS.dreamy.route;

void [
  exploreRouteContract,
  aiPicksRouteContract,
  botDetailRouteContract,
  uploadRouteContract,
  tagGeneratorRouteContract,
  libraryRouteContract,
  libraryDetailRouteContract,
  energyStoreRouteContract,
  energyHistoryRouteContract,
  earnRouteContract,
  shareInviteRouteContract,
  settingsRouteContract,
  profileRouteContract,
  checkinRouteContract,
  dreamyRouteContract,
];

const profilePageContract = resolveMiniappPageDeepLink(new URLSearchParams('page=profile'));
const energyStorePageContract = resolveMiniappPageDeepLink(new URLSearchParams('page=energy-store'));
const libraryDetailPageContract = resolveMiniappPageDeepLink(new URLSearchParams('page=library-detail&id=artifact-123'));
const legacyEnergyPageContract = resolveMiniappPageDeepLink(new URLSearchParams('page=energy'));
const legacyCheckinPageContract = resolveMiniappPageDeepLink(new URLSearchParams('page=checkin-demo'));
const buyStartContract = resolveStartParamDeepLink('buy');
const libraryDetailStartContract = resolveStartParamDeepLink('library-detail');
const libraryDetailQueryStartContract = resolveStartParamDeepLink('page=library-detail&id=artifact-123');
const taskIdQueryStartContract = resolveStartParamDeepLink('task_id=artifact-456');
const slugQueryStartContract = resolveStartParamDeepLink('slug_id=luna-star');
const botDetailStartContract = resolveStartParamDeepLink('bot-detail');
const uploadStartContract = resolveStartParamDeepLink('upload');
const tagGeneratorStartContract = resolveStartParamDeepLink('tag-generator');

void [
  profilePageContract,
  energyStorePageContract,
  libraryDetailPageContract,
  legacyEnergyPageContract,
  legacyCheckinPageContract,
  buyStartContract,
  libraryDetailStartContract,
  libraryDetailQueryStartContract,
  taskIdQueryStartContract,
  slugQueryStartContract,
  botDetailStartContract,
  uploadStartContract,
  tagGeneratorStartContract,
];
