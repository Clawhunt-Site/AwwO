export type ArtBotType = 'text-to-image' | 'image-to-image' | 'image-to-video';

export interface ArtBotCatalogItem {
  slug: string;
  name: string;
  type: ArtBotType;
  description: string;
  rating: number;
  keywords: string[];
  genButton?: string;
}

export const ART_BOTS: ArtBotCatalogItem[] = [
  {
    slug: 'seedream-multi-chart',
    name: 'Seedream 4.5',
    type: 'image-to-image',
    description: 'High fidelity image generation with reference photos',
    rating: 4.8,
    keywords: ['seedream', 'generate', 'create', 'photo', 'realistic', 'portrait', 'reference'],
    genButton: 'Start Creating',
  },
  {
    slug: 'pixel-art-generator',
    name: 'Pixel Art Generator',
    type: 'image-to-image',
    description: 'Transform photos into pixel art style',
    rating: 4.6,
    keywords: ['pixel', 'retro', '8-bit', 'game', 'pixelate'],
    genButton: 'Create Pixel Art',
  },
  {
    slug: 'sketch-generator',
    name: 'AI Sketch Generator',
    type: 'image-to-image',
    description: 'Transform photos into pencil sketch artwork',
    rating: 4.5,
    keywords: ['sketch', 'pencil', 'drawing', 'line art', 'hand-drawn'],
    genButton: 'Create Sketch Free',
  },
  {
    slug: 'neon-art-generator',
    name: 'Neon Art Generator',
    type: 'image-to-image',
    description: 'Transform photos into glowing neon masterpieces',
    rating: 4.5,
    keywords: ['neon', 'glow', 'light', 'cyberpunk', 'night'],
    genButton: 'Create Neon Art Free',
  },
  {
    slug: 'isometric-3d-poster',
    name: 'Isometric 3D Poster',
    type: 'image-to-image',
    description: 'Create isometric 3D posters from photos',
    rating: 4.4,
    keywords: ['3d', 'isometric', 'poster', 'render', 'cube'],
    genButton: 'Generate',
  },
  {
    slug: 'room-planner',
    name: 'AI Room Planner',
    type: 'image-to-image',
    description: 'Redesign any room with AI interior design',
    rating: 4.6,
    keywords: ['room', 'interior', 'design', 'home', 'decor', 'furniture'],
    genButton: 'Redesign My Room',
  },
  {
    slug: 'ad-generator',
    name: 'Ad Generator',
    type: 'image-to-image',
    description: 'Create high converting ads in seconds',
    rating: 4.4,
    keywords: ['ad', 'advertising', 'marketing', 'banner', 'commercial'],
    genButton: 'Generate Ad Free',
  },
  {
    slug: 'twitch-banner-maker',
    name: 'Twitch Banner Maker',
    type: 'image-to-image',
    description: 'Custom stream art and channel banners',
    rating: 4.3,
    keywords: ['twitch', 'banner', 'stream', 'gaming', 'channel'],
    genButton: 'Create Twitch Banner Free',
  },
  {
    slug: 'blind-box-figurine',
    name: 'Blind Box Figurine',
    type: 'image-to-image',
    description: 'Turn a photo into a custom collectible figure',
    rating: 4.6,
    keywords: ['blind box', 'figurine', 'toy', 'collectible', 'figure', '3d'],
    genButton: 'Create Blind Box Figure Free',
  },
  {
    slug: 'brat-generator',
    name: 'Brat Cover Generator',
    type: 'text-to-image',
    description: 'Create iconic album covers from text',
    rating: 4.5,
    keywords: ['brat', 'album', 'cover', 'green', 'text'],
    genButton: 'Generate Brat Cover',
  },
  {
    slug: 'ai-tattoo-generator',
    name: 'Tattoo Design Generator',
    type: 'text-to-image',
    description: 'Custom tattoo designs from text descriptions',
    rating: 4.6,
    keywords: ['tattoo', 'design', 'ink', 'body art'],
    genButton: 'Generate Tattoo Design',
  },
  {
    slug: 'grok-video-generator',
    name: 'Grok Video Maker',
    type: 'image-to-video',
    description: 'Create AI videos with the Grok Imagine flow',
    rating: 4.7,
    keywords: ['grok', 'video', 'ai video'],
    genButton: 'Generate Grok Video Free',
  },
  {
    slug: 'kling-video-generator',
    name: 'Kling Video',
    type: 'image-to-video',
    description: 'Turn photos and text into cinematic videos',
    rating: 4.7,
    keywords: ['kling', 'video', 'cinematic', 'film'],
    genButton: 'Generate Kling Video Free',
  },
  {
    slug: 'sora-video-generator',
    name: 'Sora Video Generator',
    type: 'image-to-video',
    description: 'Turn photos into cinematic AI videos',
    rating: 4.8,
    keywords: ['sora', 'video', 'cinematic'],
    genButton: 'Generate Sora Video Free',
  },
  {
    slug: 'image-animator',
    name: 'AI Image Animator',
    type: 'image-to-video',
    description: 'Breathe motion into a source photo',
    rating: 4.5,
    keywords: ['animate', 'animation', 'motion', 'life', 'move'],
    genButton: 'Create Now',
  },
];

export const PROMPT_PRESETS = [
  {
    id: 'studio-headshot',
    label: 'Studio portrait',
    prompt: 'Professional studio portrait, crisp lighting, clean background, editorial finish',
  },
  {
    id: 'anime-city',
    label: 'Anime city',
    prompt: 'Cyberpunk city at night, neon reflections, cinematic anime composition',
  },
  {
    id: 'product-ad',
    label: 'Product ad',
    prompt: 'Premium product advertisement, bold composition, glossy lighting, social campaign ready',
  },
  {
    id: 'cinematic-video',
    label: 'Cinematic video',
    prompt: 'Cinematic camera move, dramatic lighting, smooth motion, high detail video scene',
  },
];

export function getArtBot(slug: string): ArtBotCatalogItem | undefined {
  return ART_BOTS.find((bot) => bot.slug === slug);
}

export function getArtBotPageUrl(slug: string): string {
  return `https://art.myshell.ai/creative/${slug}`;
}

export function recommendArtBot(prompt: string, hasImage: boolean): ArtBotCatalogItem {
  const normalized = prompt.toLowerCase();
  const typeBoost = (bot: ArtBotCatalogItem) => {
    if (normalized.includes('video') || normalized.includes('animate') || normalized.includes('motion')) {
      return bot.type === 'image-to-video' ? 4 : 0;
    }
    if (!hasImage && bot.type === 'text-to-image') return 3;
    if (hasImage && bot.type !== 'text-to-image') return 2;
    return 0;
  };

  let best = ART_BOTS[0];
  let bestScore = -1;
  for (const bot of ART_BOTS) {
    const keywordScore = bot.keywords.reduce((score, keyword) => {
      return normalized.includes(keyword.toLowerCase()) ? score + 2 : score;
    }, 0);
    const score = keywordScore + typeBoost(bot) + bot.rating / 10;
    if (score > bestScore) {
      best = bot;
      bestScore = score;
    }
  }
  return best;
}
