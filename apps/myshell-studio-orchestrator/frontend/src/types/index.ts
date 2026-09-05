// ── Explore (Dreamy) ──

export interface FloorImage {
  imageUrl: string;
  gotoLink: string;
  title: string;
  templateUrl: string;
  imagePosterUrl: string;
  templatePosterUrl: string;
}

export interface Floor {
  title: string;
  floorUrl: string;
  images?: FloorImage[];
}

export interface ExploreResponse {
  floors: Floor[];
  total?: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
}

// ── Bot Detail ──

export interface UserScenarioItem {
  title: string;
  description: string;
  type: string;     // 'Text-Right' | 'Text-Left'
  media?: string;   // image or .mp4 video URL
}

export interface UserScenariosData {
  title: string;
  items: UserScenarioItem[];
}

export interface PageDetail {
  user_scenarios?: UserScenariosData;
  // add more sections here if needed later
}

export interface BotDetailInfo {
  activeId: string;
  botName: string;
  botId: string;
  template: string;
  floorUrl: string;
  singleText: string;
  templateImage: string;
  exploreImage: string;
  shareImage: string;
  pageContent: string;
  slugId: string;
  metaTitle: string;
  metaDesc: string;
  floorBreadcrumb: string;
  exploreImageh5: string;
  templateImageh5: string;
  botType: string;
  isTrial: boolean;
  isNsfw: boolean;
  showExample: boolean;
  estimateTaskDuration: string;
  schema?: string;
  pageDetail?: string;   // raw JSON string → parse to PageDetail
  isPro?: boolean;
  proTitle?: string;
  proImage?: string;
  proLogoImage?: string;
  dailyLeft?: number;
  lastUpdated?: string;
}

export interface BotSingleText {
  title: string;
  description: string;
  button_text: string;
  form: { title: string; component: string; index: number | null; options: { label: string; value: string; icon: string }[]; default: string }[];
}

export interface BotDetailResponse {
  info: BotDetailInfo;
  recommend: BotDetailInfo[];
  prev?: BotDetailInfo;
  after?: BotDetailInfo;
}

// ── Generate ──

export interface GenerateResponse {
  outputJobId: string;
  leftTry: number;
  totalTimes: number;
  currentTimes: number;
  queuePosition: number;
}

export interface GenerateTask {
  status: string;
  result: string;
  slugId: string;
  jobId: string;
  startTime: string;
  floorUrl: string;
  botName: string;
  creatorName: string;
  creatorAvatar: string;
  queuePosition: number;
}

export interface GenerateResultResponse {
  tasks: GenerateTask[];
}

// ── Init ──

export interface InviteInitInfo {
  appliedCode: string;       // bound code e.g. "DRM-XXXXXX", "" = not bound
}

export interface InitResponse {
  userInfo: {
    username: string;
    userId: string;
    avatarUrl: string;
  };
  energy: {
    balance: number;
    freeGenerationsLeft: number;
    hasPurchased: boolean;
  };
  energyPacks?: {
    stars: number;
    energy: number;
  }[];
  floors?: Floor[];
  inviteInfo?: InviteInitInfo;
  selfDirectorUnlocked?: boolean;
  totalGenerationCount?: number;
  language?: string;
  supported_languages?: Record<string, string>;
  // TG world: "VIP" = user has purchased an energy pack at least once.
  isVip?: boolean;
}

// ── Customize Scene (video bots) ──

export type SceneQuality = 'low' | 'medium' | 'high';
export type SceneDuration = '5s' | '8s' | '10s' | '12s';

export interface VideoCustomization {
  quality: SceneQuality;
  duration: SceneDuration;
  audio: boolean;
}

export interface EstimateEnergyCostResponse {
  estimatedEnergyCost: string;
  isFree: boolean;
  currency: string;
  estimatedTimeMinutes: number;
}

// ── Library ──

export interface LibraryItem {
  id: number;
  taskId: string;
  mediaUrl: string;
  thumbnailUrl: string;
  mediaType: string;
  characterName: string;
  likeStatus: number;  // 0=unset, 1=like, 2=dislike
  durationSeconds: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface LibraryResponse {
  items: LibraryItem[];
  has_more: boolean;
  last_id: number;
}

// ── Recommendations ──

export interface Recommendation {
  slugId: string;
  botName: string;
  wilsonScore: number;
  interactionsCount: number;
  feedbackCount: number;
  likeRatio: number;
  imageUrl: string;
  gotoLink: string;
  title: string;
  templateUrl: string;
  isTop: boolean;
  isNew: boolean;
  imagePosterUrl: string;
  templatePosterUrl: string;
  isOnCSite: string;
}

export interface RecommendationsResponse {
  recommendations: Recommendation[];
}

// ── Energy ──

export interface EnergyHistoryRecord {
  detail: string;
  date: string;
  energyChange: number;
  type: string;
  imageUrl: string;
  balanceAfter: number;
  price: string;
}

export interface EnergyHistoryResponse {
  records: EnergyHistoryRecord[];
  total: number;
  page: number;
  pageSize: number;
}
