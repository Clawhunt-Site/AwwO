"""
Bot catalog — maps ALL 38 art.myshell.ai bots into the orchestrator.
Each bot has: slug, name, type, capabilities, gen_button, keywords for intent matching.
"""

# ── Complete MyShell Art Bot Catalog ──────────────────────────────────
# type: text-to-image | image-to-image | image-to-video
# All bots live at https://art.myshell.ai/creative/{slug}

MYSHELL_BOTS = [
    # ── Text-to-Image (2) ──
    {"slug": "brat-generator", "name": "Brat Cover Generator", "icon": "💚",
     "type": "text-to-image", "gen_button": "Generate Brat Cover",
     "desc": "Create iconic Brat album covers from text",
     "keywords": ["brat", "album", "cover", "green", "text"], "rating": 4.5},
    {"slug": "ai-tattoo-generator", "name": "Tattoo Design Generator", "icon": "🖋️",
     "type": "text-to-image", "gen_button": "Generate Tattoo Design",
     "desc": "Custom tattoo designs from text descriptions",
     "keywords": ["tattoo", "design", "ink", "body art"], "rating": 4.6, "selects": 3},

    # ── Image-to-Image (23) ──
    {"slug": "seedream-multi-chart", "name": "Seedream 4.5", "icon": "✨",
     "type": "image-to-image", "gen_button": "Start Creating",
     "desc": "High-fidelity image generation with reference photos",
     "keywords": ["seedream", "generate", "create", "photo", "realistic", "portrait", "reference"], "rating": 4.8},
    {"slug": "pixel-art-generator", "name": "Pixel Art Generator", "icon": "👾",
     "type": "image-to-image", "gen_button": "Create Pixel Art",
     "desc": "Transform photos into pixel art style",
     "keywords": ["pixel", "retro", "8-bit", "game", "pixelate"], "rating": 4.6},
    {"slug": "sketch-generator", "name": "AI Sketch Generator", "icon": "✏️",
     "type": "image-to-image", "gen_button": "Create Sketch Free",
     "desc": "Transform photos into pencil sketch artwork",
     "keywords": ["sketch", "pencil", "drawing", "line art", "hand-drawn"], "rating": 4.5},
    {"slug": "neon-art-generator", "name": "Neon Art Generator", "icon": "💡",
     "type": "image-to-image", "gen_button": "Create Neon Art Free",
     "desc": "Transform photos into glowing neon masterpieces",
     "keywords": ["neon", "glow", "light", "cyberpunk", "night"], "rating": 4.5},
    {"slug": "isometric-3d-poster", "name": "Isometric 3D Poster", "icon": "🧊",
     "type": "image-to-image", "gen_button": "Generate",
     "desc": "Create isometric 3D posters from photos",
     "keywords": ["3d", "isometric", "poster", "render", "cube"], "rating": 4.4},
    {"slug": "urban-whimsy-filter", "name": "Urban Whimsy Filter", "icon": "🐟",
     "type": "image-to-image", "gen_button": "Create",
     "desc": "Transform selfies with urban whimsy fisheye look",
     "keywords": ["whimsy", "fisheye", "urban", "selfie", "fun"], "rating": 4.3},
    {"slug": "room-planner", "name": "AI Room Planner", "icon": "🏠",
     "type": "image-to-image", "gen_button": "Redesign My Room",
     "desc": "Redesign any room with AI interior design",
     "keywords": ["room", "interior", "design", "home", "decor", "furniture"], "rating": 4.6},
    {"slug": "ad-generator", "name": "Ad Generator", "icon": "📢",
     "type": "image-to-image", "gen_button": "Generate Ad Free",
     "desc": "Create high-converting ads in seconds",
     "keywords": ["ad", "advertising", "marketing", "banner", "commercial"], "rating": 4.4},
    {"slug": "twitch-banner-maker", "name": "Twitch Banner Maker", "icon": "🎮",
     "type": "image-to-image", "gen_button": "Create Twitch Banner Free",
     "desc": "Custom stream art and channel banners",
     "keywords": ["twitch", "banner", "stream", "gaming", "channel"], "rating": 4.3},
    {"slug": "blind-box-figurine", "name": "Blind Box Figurine", "icon": "🎁",
     "type": "image-to-image", "gen_button": "Create Blind Box Figure Free",
     "desc": "Turn your photo into a custom toy figure",
     "keywords": ["blind box", "figurine", "toy", "collectible", "figure", "3d"], "rating": 4.6},
    {"slug": "3d-toy-printer", "name": "3D Toy Printer", "icon": "🧸",
     "type": "image-to-image", "gen_button": "",
     "desc": "Turn any photo into a collectible 3D figure",
     "keywords": ["3d", "toy", "figure", "print", "collectible"], "rating": 4.5},
    {"slug": "apple-3d-emoji", "name": "3D Emoji Maker", "icon": "😀",
     "type": "image-to-image", "gen_button": "Create My Emoji",
     "desc": "Turn any photo into a 3D Apple-style emoji",
     "keywords": ["emoji", "3d", "apple", "face", "expression"], "rating": 4.5},
    {"slug": "emoji-generator", "name": "Custom Emoji Generator", "icon": "🎭",
     "type": "image-to-image", "gen_button": "Create Custom Emoji",
     "desc": "Create custom emojis from photos",
     "keywords": ["emoji", "custom", "sticker", "expression"], "rating": 4.4},
    {"slug": "cute-keychain-making", "name": "Cute Keychain Maker", "icon": "🔑",
     "type": "image-to-image", "gen_button": "Create Keychain Art",
     "desc": "Generate custom designs for cute keychains",
     "keywords": ["keychain", "cute", "craft", "accessory"], "rating": 4.3},
    {"slug": "giant-prop-generator", "name": "Giant Prop Filter", "icon": "🎪",
     "type": "image-to-image", "gen_button": "Create Giant Prop Art",
     "desc": "Surreal oversized object photo art",
     "keywords": ["giant", "prop", "surreal", "oversized", "fun"], "rating": 4.2},
    {"slug": "halloween-card-maker", "name": "Halloween Card Maker", "icon": "🎃",
     "type": "image-to-image", "gen_button": "Create Card Now",
     "desc": "Turn photos into custom Halloween cards",
     "keywords": ["halloween", "card", "spooky", "costume", "holiday"], "rating": 4.3},
    {"slug": "roast-me-filter", "name": "Roast Me Filter", "icon": "🔥",
     "type": "image-to-image", "gen_button": "Generate",
     "desc": "Get savage AI captions for any photo",
     "keywords": ["roast", "caption", "funny", "savage", "meme"], "rating": 4.4},
    {"slug": "old-filter", "name": "Old Filter", "icon": "👴",
     "type": "image-to-image", "gen_button": "",
     "desc": "See yourself age with AI aging filter",
     "keywords": ["old", "age", "aging", "filter", "face"], "rating": 4.3},
    {"slug": "buzz-cut-filter", "name": "Buzz Cut Filter", "icon": "💇",
     "type": "image-to-image", "gen_button": "",
     "desc": "Preview buzz cut on your photo",
     "keywords": ["buzz cut", "hair", "hairstyle", "shave"], "rating": 4.2},
    {"slug": "attractiveness-test", "name": "Attractiveness Test", "icon": "💯",
     "type": "image-to-image", "gen_button": "",
     "desc": "Rate your looks with facial analysis AI",
     "keywords": ["attractiveness", "beauty", "score", "face", "rate"], "rating": 4.4},
    {"slug": "face-symmetry-test", "name": "Face Symmetry Test", "icon": "🔮",
     "type": "image-to-image", "gen_button": "",
     "desc": "Get your face beauty symmetry score",
     "keywords": ["symmetry", "face", "beauty", "score", "analysis"], "rating": 4.3},
    {"slug": "celebrity-look-alike", "name": "Celebrity Look-Alike", "icon": "⭐",
     "type": "image-to-image", "gen_button": "",
     "desc": "Discover which celebrity you resemble",
     "keywords": ["celebrity", "look-alike", "resemble", "famous", "match"], "rating": 4.5},
    {"slug": "baby-face-maker", "name": "Baby Face Maker", "icon": "👶",
     "type": "image-to-image", "gen_button": "",
     "desc": "Predict your future baby with AI",
     "keywords": ["baby", "face", "predict", "future", "child"], "rating": 4.4},

    # ── Image-to-Video (13) ──
    {"slug": "grok-video-generator", "name": "Grok Video Maker", "icon": "🎬",
     "type": "image-to-video", "gen_button": "Generate Grok Video Free",
     "desc": "Create AI videos with xAI's Grok Imagine",
     "keywords": ["grok", "video", "xai", "ai video"], "rating": 4.7},
    {"slug": "kling-video-generator", "name": "Kling Video", "icon": "🎥",
     "type": "image-to-video", "gen_button": "Generate Kling Video Free",
     "desc": "Turn photos & text into cinematic videos",
     "keywords": ["kling", "video", "cinematic", "film"], "rating": 4.7},
    {"slug": "sora-video-generator", "name": "Sora Video Generator", "icon": "🌟",
     "type": "image-to-video", "gen_button": "Generate Sora Video Free",
     "desc": "Turn photos into cinematic AI videos with Sora",
     "keywords": ["sora", "video", "openai", "cinematic"], "rating": 4.8},
    {"slug": "vidu-q3-video", "name": "Vidu Q3 Video", "icon": "⚡",
     "type": "image-to-video", "gen_button": "Generate Vidu Video Free",
     "desc": "Fast AI video creation with Vidu Q3",
     "keywords": ["vidu", "video", "fast", "quick"], "rating": 4.5},
    {"slug": "wan-video-generator", "name": "Wan AI Video", "icon": "🎞️",
     "type": "image-to-video", "gen_button": "Generate Video Now",
     "desc": "Create stunning videos from any image",
     "keywords": ["wan", "video", "image-to-video"], "rating": 4.6},
    {"slug": "seedance-free", "name": "Seedance 2.0", "icon": "💃",
     "type": "image-to-video", "gen_button": "Generate",
     "desc": "Photorealistic video generation with Seedance",
     "keywords": ["seedance", "video", "dance", "motion", "photorealistic"], "rating": 4.7},
    {"slug": "image-animator", "name": "AI Image Animator", "icon": "🔄",
     "type": "image-to-video", "gen_button": "Create Now",
     "desc": "Breathe life into any photo with animation",
     "keywords": ["animate", "animation", "motion", "life", "move"], "rating": 4.5},
    {"slug": "earth-zoom", "name": "Earth Zoom Video", "icon": "🌍",
     "type": "image-to-video", "gen_button": "Create Earth Zoom Free",
     "desc": "Create cinematic earth zoom-in videos",
     "keywords": ["earth", "zoom", "cinematic", "map", "location"], "rating": 4.4},
    {"slug": "drunk-dance", "name": "Drunk Dance", "icon": "🕺",
     "type": "image-to-video", "gen_button": "Generate Video",
     "desc": "Create drunk dance videos from photos",
     "keywords": ["drunk", "dance", "funny", "video", "meme"], "rating": 4.4},
    {"slug": "mypopo-dance", "name": "MyPoPo Dance", "icon": "💫",
     "type": "image-to-video", "gen_button": "Generate Dance",
     "desc": "Create MyPoPo dance videos from photos",
     "keywords": ["mypopo", "dance", "viral", "video"], "rating": 4.4},
    {"slug": "pet-drunk-dance", "name": "Pet Drunk Dance", "icon": "🐾",
     "type": "image-to-video", "gen_button": "Generate Video",
     "desc": "Pet drunk dance video generator",
     "keywords": ["pet", "drunk", "dance", "animal", "funny"], "rating": 4.3},
    {"slug": "pet-mypopo-dance", "name": "Pet MyPoPo Dance", "icon": "🐶",
     "type": "image-to-video", "gen_button": "Generate Now",
     "desc": "Generate MyPoPo dance videos for pets",
     "keywords": ["pet", "mypopo", "dance", "animal"], "rating": 4.3},
    {"slug": "reunion-in-heaven", "name": "Heaven Reunion", "icon": "☁️",
     "type": "image-to-video", "gen_button": "Generate Video",
     "desc": "Reunite loved ones in a touching video",
     "keywords": ["reunion", "heaven", "memorial", "loved one", "emotional"], "rating": 4.6},
]


def get_all_bots():
    """Return full bot list"""
    return MYSHELL_BOTS


def get_bot_by_slug(slug):
    """Find bot by slug"""
    for b in MYSHELL_BOTS:
        if b["slug"] == slug:
            return b
    return None


def get_bots_by_type(bot_type):
    """Get bots by type: text-to-image, image-to-image, image-to-video"""
    return [b for b in MYSHELL_BOTS if b["type"] == bot_type]


def get_bot_info(bot_id_or_slug):
    """Get bot info by either old catalog ID or slug. Returns dict with standard fields."""
    # Try slug first
    bot = get_bot_by_slug(bot_id_or_slug)
    if bot:
        return {
            "id": bot["slug"],
            "name": bot["name"],
            "icon": bot["icon"],
            "description": bot["desc"],
            "rating": bot["rating"],
            "type": bot["type"],
            "gen_button": bot.get("gen_button", ""),
            "avg_latency_s": 15 if bot["type"] != "image-to-video" else 45,
        }
    # Fallback
    return {
        "id": bot_id_or_slug, "name": "AI Generator", "icon": "🎨",
        "description": "AI image generation", "rating": 4.5,
        "type": "text-to-image", "gen_button": "", "avg_latency_s": 15,
    }


def build_bot_list_for_prompt():
    """Build a compact bot list string for the LLM intent prompt"""
    lines = []
    for b in MYSHELL_BOTS:
        kw = ", ".join(b["keywords"][:4])
        lines.append(f'- {b["slug"]} ({b["type"]}): {b["desc"]} [keywords: {kw}]')
    return "\n".join(lines)


# ── Prompt Gallery ────────────────────────────────────────────────────

PROMPT_GALLERY = [
    {"id":"g1","category":"Portrait","prompt":"A young woman in a flowing white dress beneath cherry blossom trees, golden hour, cinematic",
     "preview_url":"/gallery/portrait-sakura.jpg","bot_name":"Seedream 4.5","bot_icon":"✨","likes":2341,
     "bot_slug":"seedream-multi-chart","bot_type":"text-to-image"},
    {"id":"g2","category":"Anime","prompt":"Cyberpunk city at night, girl with glowing headphones on a rooftop, neon reflections, anime style",
     "preview_url":"/gallery/anime-cyber.jpg","bot_name":"Seedream 4.5","bot_icon":"✨","likes":1856,
     "bot_slug":"seedream-multi-chart","bot_type":"text-to-image"},
    {"id":"g3","category":"3D","prompt":"Cute clay-style fox on a mushroom, isometric perspective, miniature world",
     "preview_url":"/gallery/3d-fox.jpg","bot_name":"Isometric 3D Poster","bot_icon":"🧊","likes":1523,
     "bot_slug":"isometric-3d-poster","bot_type":"image-to-image"},
    {"id":"g4","category":"Style Transfer","prompt":"Transform this photo into Van Gogh Starry Night style — preserve composition, add swirling brushstrokes",
     "preview_url":"/gallery/style-vangogh.jpg","bot_name":"Neon Art Generator","bot_icon":"💡","likes":1247,
     "bot_slug":"neon-art-generator","bot_type":"image-to-image"},
    {"id":"g5","category":"Creative","prompt":"A massive whale swimming through clouds, a tiny village on its back with lanterns, surrealist style",
     "preview_url":"/gallery/creative-whale.jpg","bot_name":"Seedream 4.5","bot_icon":"✨","likes":3102,
     "bot_slug":"seedream-multi-chart","bot_type":"text-to-image"},
    {"id":"g6","category":"Video","prompt":"Upload a selfie and watch it come alive — create a cinematic AI video from any photo",
     "preview_url":"/gallery/video-flower.jpg","bot_name":"Sora Video Generator","bot_icon":"🌟","likes":2432,
     "bot_slug":"sora-video-generator","bot_type":"image-to-video"},
    {"id":"g7","category":"Fun Filter","prompt":"Upload your face photo to see how you'll look in 30 years — AI aging filter",
     "preview_url":"/gallery/fun-age.jpg","bot_name":"Old Filter","bot_icon":"👴","likes":1876,
     "bot_slug":"old-filter","bot_type":"image-to-image"},
    {"id":"g8","category":"Video","prompt":"Turn your photo into a hilarious drunk dance video — instant viral content!",
     "preview_url":"/gallery/video-dance.jpg","bot_name":"Drunk Dance","bot_icon":"🕺","likes":2654,
     "bot_slug":"drunk-dance","bot_type":"image-to-video"},
    {"id":"g9","category":"Design","prompt":"Upload your room photo and redesign it with AI — modern, minimalist, or any style",
     "preview_url":"/gallery/design-room.jpg","bot_name":"AI Room Planner","bot_icon":"🏠","likes":1432,
     "bot_slug":"room-planner","bot_type":"image-to-image"},
    {"id":"g10","category":"Fun Filter","prompt":"Upload a photo to find out which celebrity you look like — AI face matching",
     "preview_url":"/gallery/fun-celeb.jpg","bot_name":"Celebrity Look-Alike","bot_icon":"⭐","likes":2198,
     "bot_slug":"celebrity-look-alike","bot_type":"image-to-image"},
    {"id":"g11","category":"3D","prompt":"Turn your selfie into a cute blind box collectible figure — 3D toy art",
     "preview_url":"/gallery/3d-blindbox.jpg","bot_name":"Blind Box Figurine","bot_icon":"🎁","likes":1876,
     "bot_slug":"blind-box-figurine","bot_type":"image-to-image"},
    {"id":"g12","category":"Design","prompt":"Create professional Twitch banners and stream overlays from your photos",
     "preview_url":"/gallery/design-banner.jpg","bot_name":"Twitch Banner Maker","bot_icon":"🎮","likes":1345,
     "bot_slug":"twitch-banner-maker","bot_type":"image-to-image"},
]
