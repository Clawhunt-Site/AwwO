import type { InitResponse, Floor, FloorImage, BotDetailInfo, BotDetailResponse, Recommendation, RecommendationsResponse, EnergyHistoryRecord, EnergyHistoryResponse } from '../types';
import type { LibraryGenerateResult } from '../services/api';
import type { FormField } from '../types/form';

// ── Helpers ──

const img = (w: number, h: number, text: string, bg = '1d1c1f', fg = 'f5f5f6') =>
  `https://placehold.co/${w}x${h}/${bg}/${fg}?text=${encodeURIComponent(text)}`;

// ── Init ──

export const mockInitResponse: InitResponse = {
  userInfo: {
    username: 'dreamy_user_42',
    userId: 'usr_mock_001',
    avatarUrl: img(80, 80, 'U'),
  },
  energy: {
    balance: 120,
    freeGenerationsLeft: 3,
    hasPurchased: false,
  },
  energyPacks: [
    { stars: 49, energy: 50 },
    { stars: 149, energy: 200 },
    { stars: 349, energy: 500 },
    { stars: 749, energy: 1200 },
  ],
  floors: [
    { title: 'Celebrity Style', floorUrl: 'celeb-sex' },
    { title: 'Sexy Outfits', floorUrl: 'sexy-outfits' },
    { title: 'Classic Acts', floorUrl: 'classic-acts' },
    { title: 'Wild Encounters', floorUrl: 'wild-encounters' },
    { title: 'LGBT', floorUrl: 'lgbt-sex' },
  ],
  inviteInfo: { appliedCode: '' },
  selfDirectorUnlocked: false,
  totalGenerationCount: 7,
  language: 'en',
  supported_languages: { en: 'English', zh: '中文', es: 'Español', ja: '日本語' },
};

// ── Bot Details ──

function makeBotDetail(overrides: Partial<BotDetailInfo> & { botName: string; slugId: string }): BotDetailInfo {
  const { botName: name, slugId: slug, ...rest } = overrides;
  return {
    activeId: `act_${slug}`,
    botId: `bot_${slug}`,
    template: 'default',
    floorUrl: 'celeb-sex',
    singleText: JSON.stringify({
      title: name,
      description: `Generate stunning images with ${name}`,
      button_text: 'Generate',
      form: [],
    }),
    templateImage: img(300, 400, name.replace(/ /g, '+')),
    exploreImage: img(300, 400, name.replace(/ /g, '+')),
    shareImage: img(600, 400, name.replace(/ /g, '+')),
    pageContent: `<p>Create amazing AI art with <b>${name}</b>.</p>`,
    metaTitle: `${name} — Dreamy AI`,
    metaDesc: `Use ${name} to create AI-generated images.`,
    floorBreadcrumb: 'Celebrity Style',
    exploreImageh5: img(180, 240, name.replace(/ /g, '+')),
    templateImageh5: img(180, 240, name.replace(/ /g, '+')),
    botType: 'image',
    isTrial: false,
    isNsfw: true,
    showExample: true,
    estimateTaskDuration: '30',
    ...rest,
    botName: name,
    slugId: slug,
  };
}

const botNames = [
  { botName: 'Luna Star', slugId: 'luna-star', floorUrl: 'celeb-sex' },
  { botName: 'Crystal Rose', slugId: 'crystal-rose', floorUrl: 'sexy-outfits' },
  { botName: 'Ember Fox', slugId: 'ember-fox', floorUrl: 'classic-acts' },
  { botName: 'Jade River', slugId: 'jade-river', floorUrl: 'wild-encounters' },
  { botName: 'Nova Silk', slugId: 'nova-silk', floorUrl: 'celeb-sex' },
  { botName: 'Scarlet Bloom', slugId: 'scarlet-bloom', floorUrl: 'sexy-outfits' },
  { botName: 'Aurora Dusk', slugId: 'aurora-dusk', floorUrl: 'classic-acts', botType: 'video', estimateTaskDuration: '60' },
  { botName: 'Violet Haze', slugId: 'violet-haze', floorUrl: 'lgbt-sex' },
] as const;

const allBots: BotDetailInfo[] = botNames.map(b => makeBotDetail(b));

export const mockBotDetail: BotDetailInfo = allBots[0];

export const mockBotDetailResponse: BotDetailResponse = {
  info: allBots[0],
  recommend: allBots.slice(1, 5),
};

// ── Explore (FloorImages built from allBots) ──

function botToFloorImage(bot: BotDetailInfo): FloorImage {
  return {
    imageUrl: bot.exploreImage,
    gotoLink: `/bot?slug_id=${bot.slugId}`,
    title: bot.botName,
    templateUrl: bot.templateImage,
    imagePosterUrl: bot.exploreImageh5,
    templatePosterUrl: bot.templateImageh5,
  };
}

export const mockExploreFloors: Floor[] = [
  {
    title: 'Celebrity Style',
    floorUrl: 'celeb-sex',
    images: allBots.filter(b => b.floorUrl === 'celeb-sex').map(botToFloorImage),
  },
  {
    title: 'Sexy Outfits',
    floorUrl: 'sexy-outfits',
    images: allBots.filter(b => b.floorUrl === 'sexy-outfits').map(botToFloorImage),
  },
  {
    title: 'Classic Acts',
    floorUrl: 'classic-acts',
    images: allBots.filter(b => b.floorUrl === 'classic-acts').map(botToFloorImage),
  },
  {
    title: 'Wild Encounters',
    floorUrl: 'wild-encounters',
    images: allBots.filter(b => b.floorUrl === 'wild-encounters').map(botToFloorImage),
  },
  {
    title: 'LGBT',
    floorUrl: 'lgbt-sex',
    images: allBots.filter(b => b.floorUrl === 'lgbt-sex').map(botToFloorImage),
  },
];

// ── Recommendations ──

export const mockRecommendations: Recommendation[] = allBots.slice(0, 4).map((bot, i) => ({
  slugId: bot.slugId,
  botName: bot.botName,
  wilsonScore: 0.92 - i * 0.05,
  interactionsCount: 12000 - i * 2000,
  feedbackCount: 3400 - i * 500,
  likeRatio: 0.95 - i * 0.02,
  imageUrl: bot.exploreImage,
  gotoLink: `/bot?slug_id=${bot.slugId}`,
  title: bot.botName,
  templateUrl: bot.templateImage,
  isTop: i === 0,
  isNew: i === 3,
  imagePosterUrl: bot.exploreImageh5,
  templatePosterUrl: bot.templateImageh5,
  isOnCSite: 'true',
}));

// ── Library Items ──

export const mockLibraryItems: LibraryGenerateResult[] = [
  {
    status: 'done',
    result: {
      outputImg: img(512, 768, 'Result+1'),
      inputImg: [img(300, 400, 'Input+1')],
      width: '512',
      height: '768',
      errMsg: '',
      outputPreview: img(256, 384, 'Preview+1'),
      outputPoster: img(128, 192, 'Poster+1'),
    },
    botId: 'bot_luna-star',
    slugId: 'luna-star',
    taskId: 'task_001',
    startTime: '2026-04-22T14:30:00Z',
    floorUrl: 'celeb-sex',
    botName: 'Luna Star',
    imageUrl: img(300, 400, 'Luna+Star'),
    botType: 'image',
    likeStatus: '1',
    estimateTaskDuration: '30',
    isAiPick: true,
  },
  {
    status: 'done',
    result: {
      outputImg: img(512, 768, 'Result+2'),
      inputImg: [img(300, 400, 'Input+2')],
      width: '512',
      height: '768',
      errMsg: '',
      outputPreview: img(256, 384, 'Preview+2'),
      outputPoster: img(128, 192, 'Poster+2'),
    },
    botId: 'bot_crystal-rose',
    slugId: 'crystal-rose',
    taskId: 'task_002',
    startTime: '2026-04-22T12:15:00Z',
    floorUrl: 'sexy-outfits',
    botName: 'Crystal Rose',
    imageUrl: img(300, 400, 'Crystal+Rose'),
    botType: 'image',
    likeStatus: '0',
    estimateTaskDuration: '30',
  },
  {
    status: 'running',
    result: {
      outputImg: '',
      inputImg: [img(300, 400, 'Input+3')],
      width: '',
      height: '',
      errMsg: '',
      outputPreview: '',
      outputPoster: '',
    },
    botId: 'bot_ember-fox',
    slugId: 'ember-fox',
    taskId: 'task_003',
    startTime: '2026-04-23T09:45:00Z',
    floorUrl: 'classic-acts',
    botName: 'Ember Fox',
    imageUrl: img(300, 400, 'Ember+Fox'),
    botType: 'image',
    likeStatus: '0',
    estimateTaskDuration: '30',
  },
  {
    status: 'error',
    result: {
      outputImg: '',
      inputImg: [img(300, 400, 'Input+4')],
      width: '',
      height: '',
      errMsg: 'Generation failed: content policy violation',
      outputPreview: '',
      outputPoster: '',
    },
    botId: 'bot_jade-river',
    slugId: 'jade-river',
    taskId: 'task_004',
    startTime: '2026-04-21T18:00:00Z',
    floorUrl: 'wild-encounters',
    botName: 'Jade River',
    imageUrl: img(300, 400, 'Jade+River'),
    botType: 'image',
    likeStatus: '0',
    estimateTaskDuration: '30',
  },
  {
    status: 'done',
    result: {
      outputImg: img(512, 512, 'Video+Result'),
      inputImg: [img(300, 400, 'Input+5')],
      width: '512',
      height: '512',
      errMsg: '',
      outputPreview: img(256, 256, 'Video+Preview'),
      outputPoster: img(128, 128, 'Video+Poster'),
    },
    botId: 'bot_aurora-dusk',
    slugId: 'aurora-dusk',
    taskId: 'task_005',
    startTime: '2026-04-20T10:30:00Z',
    floorUrl: 'classic-acts',
    botName: 'Aurora Dusk',
    imageUrl: img(300, 400, 'Aurora+Dusk'),
    botType: 'video',
    likeStatus: '2',
    estimateTaskDuration: '60',
  },
];

// ── Energy History ──

export const mockEnergyHistory: EnergyHistoryRecord[] = [
  {
    detail: 'Generated image with Luna Star',
    date: '2026-04-23T10:00:00Z',
    energyChange: -10,
    type: 'generation',
    imageUrl: img(64, 64, 'Gen'),
    balanceAfter: 120,
    price: '',
  },
  {
    detail: 'Purchased 200 Energy',
    date: '2026-04-22T08:30:00Z',
    energyChange: 200,
    type: 'purchase',
    imageUrl: '',
    balanceAfter: 130,
    price: '149 Stars',
  },
  {
    detail: 'Generated video with Aurora Dusk',
    date: '2026-04-21T16:45:00Z',
    energyChange: -20,
    type: 'generation',
    imageUrl: img(64, 64, 'Vid'),
    balanceAfter: -70,
    price: '',
  },
  {
    detail: 'Friend invited — bonus energy',
    date: '2026-04-20T12:00:00Z',
    energyChange: 50,
    type: 'invite',
    imageUrl: '',
    balanceAfter: -50,
    price: '',
  },
  {
    detail: 'Daily free generation',
    date: '2026-04-19T09:00:00Z',
    energyChange: 0,
    type: 'free',
    imageUrl: img(64, 64, 'Free'),
    balanceAfter: -100,
    price: '',
  },
];

// ── Earn ──

export interface EarnData {
  inviteCode: string;
  inviteLink: string;
  friendsInvited: number;
  energyEarnedFromInvite: number;
}

export const mockEarnData: EarnData = {
  inviteCode: 'DRM-X7K9P2',
  inviteLink: 'https://t.me/DreamyPornBot?start=invite_DRM-X7K9P2',
  friendsInvited: 3,
  energyEarnedFromInvite: 150,
};

// ── Energy Packs ──

export const mockEnergyPacks = [
  { stars: 49, energy: 50 },
  { stars: 149, energy: 200 },
  { stars: 349, energy: 500 },
  { stars: 749, energy: 1200 },
];

// ── Form Fields (for DynamicForm stories) ──

export const mockFormFields: FormField[] = [
  {
    title: 'Upload your photo',
    component: 'Uploader',
    index: 0,
    options: [],
    default: '',
    required: true,
  },
  {
    title: 'Style',
    component: 'RadioGroup',
    index: 1,
    options: [
      { label: 'Realistic', value: 'realistic' },
      { label: 'Anime', value: 'anime' },
      { label: 'Fantasy', value: 'fantasy' },
    ],
    default: 'realistic',
    required: true,
  },
  {
    title: 'Character',
    component: 'ImageChoices',
    index: 2,
    options: [
      { label: 'Luna', value: 'luna', image: img(120, 160, 'Luna') },
      { label: 'Crystal', value: 'crystal', image: img(120, 160, 'Crystal') },
      { label: 'Ember', value: 'ember', image: img(120, 160, 'Ember') },
      { label: 'Jade', value: 'jade', image: img(120, 160, 'Jade') },
    ],
    default: 'luna',
  },
  {
    title: 'Pose',
    component: 'Selector',
    index: 3,
    options: [
      { label: 'Standing', value: 'standing' },
      { label: 'Sitting', value: 'sitting' },
      { label: 'Lying', value: 'lying' },
      { label: 'Dynamic', value: 'dynamic' },
    ],
    default: 'standing',
  },
  {
    title: 'Custom prompt',
    component: 'Prompt',
    index: 4,
    options: [],
    default: '',
    required: false,
  },
];
